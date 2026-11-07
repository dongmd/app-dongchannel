/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-03 (PRJ-07, PLN-05, PLN-06, PLN-07, OFC-05): coordination between tasks and between bots, always THROUGH the app.
 *  - dependencies: a task waits (ON_HOLD / WAITING_DEPENDENCY) until the upstream output is accepted at an exact version; cycles are refused; reopening
 *    an upstream marks the downstream "cần kiểm lại";
 *  - handoffs: a structured ticket from one bot's task to another bot, checked DETERMINISTICALLY before it is created, with depth/round limits that come from
 *    the owner's policies (no built-in numbers) and ping-pong escalated to the owner; the receiver accepts, rejects with a reason or asks for information;
 *  - PM change proposals: a PM bot may PROPOSE a new assignee; it waits for the owner unless the owner allowed automatic application for that project.
 * Nothing here grants authority: grants/allowlists/capability are never touched.
 */
import { createHash } from "node:crypto";
import { activity, audit, createRun, enqueueNotify, LumiError, requireRole, runTotalCap, tryReleaseTask, type Db } from "./core";
import { createTaskInTx } from "./core-web";
import { requirePolicy } from "./policies";
import { uniqueViolation } from "./assistants";
import { canInitiateInternal } from "./levels";

const iso = (d: Date) => d.toISOString();
const HOLDABLE = ["CAPTURED", "QUEUED", "WAITING_ASSISTANT", "ON_HOLD"];
const REASSIGNABLE = ["CAPTURED", "QUEUED", "WAITING_ASSISTANT", "ON_HOLD", "FAILED", "REJECTED"];
const IN_FLIGHT = ["DISPATCHED", "DISPATCH_UNCERTAIN", "RUNNING"];
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/** Drop runs that were never sent (and their queue rows) so a held/reassigned task cannot be dispatched by mistake. */
async function dropPendingRuns(t: Db, taskId: string, now: Date, why: string) {
  const pend = await t.query<any>(`UPDATE lumi_task_runs SET state='CANCELLED',finished_at=$2 WHERE task_id=$1 AND state='PENDING' RETURNING id`, [taskId, iso(now)]);
  if (pend.length) await t.query(`UPDATE lumi_outbox SET state='DEAD',last_error=$2,lease_owner=NULL,lease_expires_at=NULL WHERE kind='DISPATCH_RUN' AND state IN ('PENDING','LEASED') AND aggregate_id = ANY($1::uuid[])`, [pend.map((r: any) => r.id), why]);
  return pend.length;
}

// ───────────────────────── dependencies (PRJ-07 / PLN-05)
async function reaches(t: Db, from: string, target: string): Promise<string[] | null> {
  // is `target` reachable from `from` following "depends on" edges? (a path found = adding target→...→from would close a cycle)
  const seen = new Set<string>(); const stack: { id: string; path: string[] }[] = [{ id: from, path: [from] }];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.id === target) return cur.path;
    if (seen.has(cur.id)) continue; seen.add(cur.id);
    for (const e of await t.query<any>(`SELECT depends_on_task_id AS up FROM lumi_task_deps WHERE task_id=$1`, [cur.id])) stack.push({ id: e.up, path: [...cur.path, e.up] });
  }
  return null;
}

export async function addDependency(db: Db, a: { actorRef: string; taskId: string; dependsOnId: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (a.taskId === a.dependsOnId) throw new LumiError("DEP_CYCLE", 409, { path: [a.taskId] });
  return db.tx(async (t) => {
    // serialize dependency changes per project: a cycle of three or more edges can be closed by edges that lock different task pairs
    const [pr] = await t.query<any>(`SELECT project_id FROM tasks WHERE id=$1`, [a.taskId]);
    if (pr?.project_id) await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`lumi_deps:${pr.project_id}`]);
    const ids = [a.taskId, a.dependsOnId].sort();
    const rows = await t.query<any>(`SELECT * FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids]);
    const k = rows.find((r: any) => r.id === a.taskId); const up = rows.find((r: any) => r.id === a.dependsOnId);
    if (!k || !up) throw new LumiError("NOT_FOUND", 404);
    if (!k.project_id || k.project_id !== up.project_id) throw new LumiError("DEP_CROSS_PROJECT", 409);
    const [dup] = await t.query<any>(`SELECT id FROM lumi_task_deps WHERE task_id=$1 AND depends_on_task_id=$2`, [a.taskId, a.dependsOnId]);
    if (dup) return { alreadyProcessed: true as const, held: false };
    if (["CANCELLED", "REJECTED"].includes(up.status)) throw new LumiError("DEP_UPSTREAM_CLOSED", 409, { status: up.status });
    if (!HOLDABLE.includes(k.status)) throw new LumiError("DEP_DOWNSTREAM_STARTED", 409, { status: k.status });
    if ((await t.query(`SELECT 1 FROM lumi_task_runs WHERE task_id=$1 AND state NOT IN ('PENDING','CANCELLED')`, [a.taskId])).length) throw new LumiError("DEP_DOWNSTREAM_STARTED", 409, { reason: "đã có lượt chạy" });
    const path = await reaches(t, a.dependsOnId, a.taskId);
    if (path) { const codes = await t.query<any>(`SELECT id,code FROM tasks WHERE id = ANY($1::uuid[])`, [[...path, a.taskId]]); const code = new Map(codes.map((c: any) => [c.id, c.code])); throw new LumiError("DEP_CYCLE", 409, { path: [a.taskId, ...path.slice().reverse()].map((x) => code.get(x) ?? x) }); }
    let consumed: any = null;
    if (up.status === "COMPLETED" && up.current_output_id) { [consumed] = await t.query<any>(`SELECT id,version FROM lumi_task_outputs WHERE id=$1 AND state='APPROVED'`, [up.current_output_id]); }
    await t.query(`INSERT INTO lumi_task_deps(task_id,depends_on_task_id,consumed_version,consumed_output_id,created_by) VALUES ($1,$2,$3,$4,$5)`, [a.taskId, a.dependsOnId, consumed?.version ?? null, consumed?.id ?? null, a.actorRef]);
    let held = false;
    if (!consumed && k.status !== "ON_HOLD") {
      await dropPendingRuns(t, a.taskId, a.now, "dependency added");
      await t.query(`UPDATE tasks SET status='ON_HOLD',hold_reason='WAITING_DEPENDENCY',updated_at=$2 WHERE id=$1`, [a.taskId, iso(a.now)]);
      held = true;
    } else if (!consumed) {
      await t.query(`UPDATE tasks SET hold_reason=coalesce(hold_reason,'WAITING_DEPENDENCY') WHERE id=$1`, [a.taskId]);
    }
    await activity(t, a.taskId, "dependency.added", a.now, { on: up.code, consumed: consumed?.version ?? null, held });
    await audit(t, "task.dependency_added", a.actorRef, { taskId: a.taskId, dependsOn: a.dependsOnId }, a.now);
    return { alreadyProcessed: false as const, held };
  });
}

export async function removeDependency(db: Db, a: { actorRef: string; taskId: string; dependsOnId: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  return db.tx(async (t) => {
    const r = await t.query<any>(`DELETE FROM lumi_task_deps WHERE task_id=$1 AND depends_on_task_id=$2 RETURNING id`, [a.taskId, a.dependsOnId]);
    if (!r.length) throw new LumiError("NOT_FOUND", 404);
    await activity(t, a.taskId, "dependency.removed", a.now, { on: a.dependsOnId });
    await tryReleaseTask(t, a.taskId, a.now);
    await audit(t, "task.dependency_removed", a.actorRef, { taskId: a.taskId, dependsOn: a.dependsOnId }, a.now);
    return { removed: true as const };
  });
}

/** The owner reopens a finished task (its accepted input changes). Downstream tasks are held or flagged "cần kiểm lại"; nothing is silently treated as still valid. */
export async function reopenTask(db: Db, a: { actorRef: string; taskId: string; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if ((a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  return db.tx(async (t) => {
    const [k] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [a.taskId]);
    if (!k) throw new LumiError("NOT_FOUND", 404);
    if (k.status !== "COMPLETED") throw new LumiError("INVALID_TRANSITION", 409, { status: k.status });
    await t.query(`UPDATE tasks SET status='REVISION_REQUESTED',review_status='REVISION_REQUESTED',updated_at=$2 WHERE id=$1`, [a.taskId, iso(a.now)]);
    await t.query(`UPDATE lumi_task_outputs SET state='SUPERSEDED' WHERE id=$1 AND state='APPROVED'`, [k.current_output_id]);
    const down = await t.query<any>(`SELECT d.id AS edge_id, d.task_id, x.status::text AS status, x.code FROM lumi_task_deps d JOIN tasks x ON x.id=d.task_id WHERE d.depends_on_task_id=$1`, [a.taskId]);
    let held = 0; let flagged = 0;
    for (const e of down) {
      await t.query(`UPDATE lumi_task_deps SET stale=true WHERE id=$1`, [e.edge_id]);
      if (HOLDABLE.includes(e.status)) {
        await dropPendingRuns(t, e.task_id, a.now, "upstream reopened");
        await t.query(`UPDATE tasks SET status='ON_HOLD',hold_reason='WAITING_DEPENDENCY',updated_at=$2 WHERE id=$1`, [e.task_id, iso(a.now)]);
        held += 1;
      } else {
        await t.query(`UPDATE tasks SET needs_decision=true,updated_at=$2 WHERE id=$1`, [e.task_id, iso(a.now)]); // started or finished on the OLD input version: "cần kiểm lại"
        flagged += 1;
      }
      await activity(t, e.task_id, "dependency.input_changed", a.now, { upstream: k.code, reason: a.reason });
    }
    await activity(t, a.taskId, "task.reopened", a.now, { reason: a.reason, downstreamHeld: held, downstreamFlagged: flagged });
    await audit(t, "task.reopened", a.actorRef, { taskId: a.taskId, reason: a.reason, held, flagged }, a.now);
    return { held, flagged };
  });
}

export async function clearRecheck(db: Db, a: { actorRef: string; taskId: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [k] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [a.taskId]);
    if (!k) throw new LumiError("NOT_FOUND", 404);
    const stale = await t.query(`SELECT 1 FROM lumi_task_deps WHERE task_id=$1 AND stale`, [a.taskId]);
    if (stale.length && ["COMPLETED", "WAITING_REVIEW", "RUNNING"].includes(k.status)) {
      await t.query(`UPDATE lumi_task_deps SET stale=false WHERE task_id=$1`, [a.taskId]); // the owner reviewed the output against the new input version
    }
    await t.query(`UPDATE tasks SET needs_decision=false,updated_at=$2 WHERE id=$1`, [a.taskId, iso(a.now)]);
    await activity(t, a.taskId, "dependency.recheck_cleared", a.now, { by: a.actorRef });
    return { cleared: true as const };
  });
}

// ───────────────────────── reassignment (shared by ORG-03 transfers and PM proposals)
export async function reassignTaskTx(t: Db, a: { taskId: string; toAssistantId: string; actorRef: string; reason: string; now: Date }) {
  const [k] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [a.taskId]);
  if (!k) throw new LumiError("NOT_FOUND", 404);
  if (!REASSIGNABLE.includes(k.status)) throw new LumiError("INVALID_TRANSITION", 409, { status: k.status });
  if ((await t.query(`SELECT 1 FROM lumi_task_runs WHERE task_id=$1 AND state = ANY($2::text[])`, [a.taskId, IN_FLIGHT])).length) throw new LumiError("RUN_ACTIVE", 409);
  const [to] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [a.toAssistantId]);
  if (!to) throw new LumiError("NOT_FOUND", 404, { what: "assignee" });
  const fromId = k.owner_assistant_id;
  await dropPendingRuns(t, a.taskId, a.now, "reassigned");
  await t.query(`UPDATE tasks SET owner_kind='BOT',owner_assistant_id=$2,owner_actor_ref=NULL,profile_slug=$3,updated_at=$4 WHERE id=$1`, [a.taskId, to.id, to.hermes_profile ?? "unassigned", iso(a.now)]);
  const unmet = await t.query(`SELECT 1 FROM lumi_task_deps WHERE task_id=$1 AND (consumed_version IS NULL OR stale)`, [a.taskId]);
  const ready = to.connection_state === "VERIFIED" && to.dispatch_enabled && !to.dispatch_paused;
  if (unmet.length) await t.query(`UPDATE tasks SET status='ON_HOLD',hold_reason='WAITING_DEPENDENCY' WHERE id=$1`, [a.taskId]);
  else if (!ready) await t.query(`UPDATE tasks SET status='WAITING_ASSISTANT',hold_reason=NULL,error_code=NULL,needs_decision=false WHERE id=$1`, [a.taskId]);
  else {
    await createRun(t, a.taskId, to, "REASSIGN", a.now, { text: k.description ?? k.title, title: k.title, expected_output: k.expected_output ?? null, instruction: a.reason });
    await t.query(`UPDATE tasks SET status='QUEUED',hold_reason=NULL,error_code=NULL,error_message=NULL,needs_decision=false WHERE id=$1`, [a.taskId]);
  }
  await activity(t, a.taskId, "task.reassigned", a.now, { from: fromId, to: to.id, reason: a.reason, by: a.actorRef });
  return { toSlug: to.slug as string, fromId: fromId as string | null };
}

// ───────────────────────── handoffs (PLN-06 / PLN-07)
export interface HandoffInput {
  sourceTaskId: string; toAssistantId: string; title: string; request: string; expectedOutput?: string; acceptance?: string; requiredSkill?: string;
  /** who is acting: a person (OWNER/ADMIN) or a bot (assistant id; must be the owner of the source task and at execution level >= 2) */
  by: { actorRef: string; assistantId?: string };
  idempotencyKey: string; now: Date;
}
export interface ReceiverCheck { ok: boolean; reasons: { code: string; text: string; suggestion: string }[] }

/** Deterministic pre-assignment check of the receiving assistant (no model involved). */
export async function checkReceiver(t: Db, to: any, o: { requiredSkill?: string; now: Date }): Promise<ReceiverCheck> {
  const reasons: ReceiverCheck["reasons"] = [];
  if (!to || to.status !== "ACTIVE") reasons.push({ code: "NOT_ACTIVE", text: "Bên nhận đã lưu trữ hoặc không tồn tại.", suggestion: "Chọn trợ lý khác." });
  else {
    if (to.connection_state !== "VERIFIED") reasons.push({ code: "NOT_CONNECTED", text: "Bên nhận chưa kết nối (chưa kiểm tra thật).", suggestion: "Chủ kiểm tra kết nối ở Tổ chức." });
    if (!to.dispatch_enabled) reasons.push({ code: "DISPATCH_OFF", text: "Bên nhận đang tắt giao việc.", suggestion: "Chủ bật giao việc cho bên nhận." });
    if (to.dispatch_paused) reasons.push({ code: "DISPATCH_PAUSED", text: "Bên nhận đang tạm dừng giao việc.", suggestion: "Chờ hoặc chọn bên nhận khác." });
    if (to.max_runs_per_day != null) {
      const [c] = await t.query<{ n: string }>(`SELECT count(*)::text AS n FROM lumi_task_runs WHERE assistant_id=$1 AND created_at >= date_trunc('day',$2::timestamptz)`, [to.id, iso(o.now)]);
      if (Number(c!.n) >= to.max_runs_per_day) reasons.push({ code: "CAPACITY_DAY", text: `Bên nhận đã đủ ${to.max_runs_per_day} lượt chạy hôm nay.`, suggestion: "Hẹn ngày mai hoặc nâng giới hạn lượt/ngày." });
    }
    const cap = runTotalCap(to.slug);
    if (cap !== null) {
      const [c] = await t.query<{ n: string }>(`SELECT count(*)::text AS n FROM lumi_task_runs WHERE assistant_id=$1`, [to.id]);
      if (Number(c!.n) >= cap) reasons.push({ code: "CAPACITY_TOTAL", text: `Bên nhận đã đủ tổng ${cap} lượt chạy Chủ đã duyệt.`, suggestion: "Chủ duyệt thêm hạn mức rồi mới giao." });
    }
    if (o.requiredSkill) {
      const [s] = await t.query<any>(`SELECT state FROM lumi_skills WHERE assistant_id=$1 AND lower(skill)=lower($2)`, [to.id, o.requiredSkill]);
      if (!s || s.state === "UNVERIFIED") reasons.push({ code: "SKILL_UNVERIFIED", text: `Năng lực «${o.requiredSkill}» của bên nhận chưa được kiểm chứng.`, suggestion: "Chủ đánh giá và ghi bằng chứng ở Tổ chức → Năng lực, hoặc chọn bên nhận khác." });
    }
  }
  return { ok: reasons.length === 0, reasons };
}

async function handoffDepth(t: Db, sourceTaskId: string): Promise<{ depth: number; chain: { from: string | null; to: string }[] }> {
  const chain: { from: string | null; to: string }[] = []; let cur = sourceTaskId; let depth = 0;
  for (let i = 0; i < 50; i++) {
    const [p] = await t.query<any>(`SELECT source_task_id,from_assistant_id,to_assistant_id FROM lumi_handoffs WHERE new_task_id=$1`, [cur]);
    if (!p) break;
    chain.push({ from: p.from_assistant_id, to: p.to_assistant_id }); cur = p.source_task_id; depth += 1;
  }
  return { depth, chain };
}

export async function proposeHandoff(db: Db, i: HandoffInput) {
  const bad: string[] = [];
  if (typeof i.title !== "string" || i.title.trim().length < 3 || i.title.length > 200) bad.push("title(3..200)");
  if (typeof i.request !== "string" || i.request.trim().length < 3 || i.request.length > 4000) bad.push("request(3..4000)");
  if (!i.idempotencyKey || i.idempotencyKey.length < 8) bad.push("idempotency_key");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { missing: bad });
  if (i.by.assistantId === undefined) await requireRole(db, i.by.actorRef, ["OWNER", "ADMIN"]);
  try {
    const res = await db.tx(async (t) => {
      const [prior] = await t.query<any>(`SELECT * FROM lumi_handoffs WHERE idempotency_key=$1`, [i.idempotencyKey]);
      if (prior) return { handoff: prior, task: (await t.query<any>(`SELECT id,code,status FROM tasks WHERE id=$1`, [prior.new_task_id]))[0], alreadyProcessed: true as const };
      const [src] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [i.sourceTaskId]);
      if (!src || !src.project_id) throw new LumiError("NOT_FOUND", 404, { what: "source task" });
      if (["CANCELLED", "REJECTED", "FAILED"].includes(src.status)) throw new LumiError("INVALID_TRANSITION", 409, { status: src.status });
      let fromAsst: any = null;
      if (i.by.assistantId !== undefined) {
        [fromAsst] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [i.by.assistantId]);
        if (!fromAsst || src.owner_assistant_id !== fromAsst.id) throw new LumiError("FORBIDDEN", 403);
        if (!canInitiateInternal(fromAsst.execution_level)) throw new LumiError("LEVEL_TOO_LOW", 403, { level: fromAsst.execution_level, needs: 2 });
      } else if (src.owner_assistant_id) fromAsst = (await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [src.owner_assistant_id]))[0] ?? null;
      const [to] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [i.toAssistantId]);
      if (to && fromAsst && to.id === fromAsst.id) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["to(khác bên giao)"] });
      // the owner's limits are POLICIES: not set => blocked with the reason named (no invented number)
      const maxDepth = Number((await requirePolicy(t, "handoff_max_depth")).value);
      const maxRounds = Number((await requirePolicy(t, "handoff_max_rounds")).value);
      const { depth: srcDepth, chain } = await handoffDepth(t, src.id);
      const depth = srcDepth + 1;
      // a refusal must still COMMIT its audit row, notification and owner flag: the transaction returns a marker and the error is thrown AFTER it
      const fail = async (reasons: ReceiverCheck["reasons"]) => {
        await audit(t, "handoff.refused", i.by.actorRef, { sourceTaskId: src.id, to: i.toAssistantId, reasons: reasons.map((r) => r.code) }, i.now);
        await enqueueNotify(t, `notify:handoff-refused:${h(i.idempotencyKey)}`, { type: "HANDOFF_REFUSED", taskCode: src.code, reasons: reasons.map((r) => r.code) }, i.now);
        return { refused: reasons } as const;
      };
      if (depth > maxDepth) return fail([{ code: "DEPTH_LIMIT", text: `Chuỗi bàn giao đã đạt độ sâu tối đa Chủ đặt (${maxDepth}).`, suggestion: "Chủ xử lý trực tiếp hoặc nâng chính sách độ sâu." }]);
      // ping-pong: the same pair handing work back and forth along this chain
      const pair = (a: string | null, b: string | null) => [a ?? "", b ?? ""].sort().join("|");
      const same = chain.filter((c) => pair(c.from, c.to) === pair(fromAsst?.id ?? null, i.toAssistantId)).length;
      if (same >= maxRounds) {
        await t.query(`UPDATE tasks SET needs_decision=true,updated_at=$2 WHERE id=$1`, [src.id, iso(i.now)]);
        return fail([{ code: "ROUND_LIMIT", text: `Hai bên đã bàn giao qua lại ${same} lần (giới hạn ${maxRounds}).`, suggestion: "Chủ quyết định ai chịu trách nhiệm tiếp (trưởng kế hoạch giải quyết theo quy tắc)." }]);
      }
      const check = await checkReceiver(t, to, { requiredSkill: i.requiredSkill, now: i.now });
      if (!check.ok) return fail(check.reasons);
      // create the receiver's task HELD until the upstream output is accepted at an exact version
      const created = await createTaskInTx(t, {
        actorRef: i.by.actorRef, clientRequestId: `handoff-${h(i.idempotencyKey)}`, projectId: src.project_id, assigneeId: to.id, title: i.title.trim(), description: i.request.trim(),
        expectedOutput: i.expectedOutput, now: i.now,
      });
      const nt = created.task;
      await dropPendingRuns(t, nt.id, i.now, "handoff holds until input accepted");
      await t.query(`UPDATE tasks SET status='ON_HOLD',hold_reason='WAITING_DEPENDENCY',required_skill=$2,role_id=$3,updated_at=$4 WHERE id=$1`, [nt.id, i.requiredSkill ?? null, src.role_id ?? null, iso(i.now)]);
      let consumed: any = null;
      if (src.status === "COMPLETED" && src.current_output_id) [consumed] = await t.query<any>(`SELECT id,version FROM lumi_task_outputs WHERE id=$1 AND state='APPROVED'`, [src.current_output_id]);
      await t.query(`INSERT INTO lumi_task_deps(task_id,depends_on_task_id,consumed_version,consumed_output_id,created_by) VALUES ($1,$2,$3,$4,$5)`, [nt.id, src.id, consumed?.version ?? null, consumed?.id ?? null, i.by.actorRef]);
      const ticket = {
        source_task: src.code, source_output_version: consumed?.version ?? null, primary: to.slug, support: [], inputs: [{ task: src.code, version: consumed?.version ?? null }],
        expected_output: i.expectedOutput ?? null, acceptance: i.acceptance ?? null, depends_on: [src.code], budget: null, accounts: [], store: "app", report_when: ["từ chối kèm lý do", "cần thêm thông tin", "đầu ra đã nộp"],
        required_skill: i.requiredSkill ?? null,
      };
      const [ho] = await t.query<any>(
        `INSERT INTO lumi_handoffs(code,idempotency_key,source_task_id,from_assistant_id,to_assistant_id,new_task_id,depth,ticket,created_by,created_at)
         VALUES ('HO-'||lpad(nextval('lumi_handoff_code_seq')::text,3,'0'),$1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
        [i.idempotencyKey, src.id, fromAsst?.id ?? null, to.id, nt.id, depth, JSON.stringify(ticket), i.by.actorRef, iso(i.now)]);
      await t.query(`INSERT INTO lumi_handoff_events(handoff_id,event_type,actor_ref,text,created_at) VALUES ($1,'PROPOSED',$2,$3,$4)`, [ho.id, i.by.actorRef, i.request.trim().slice(0, 500), iso(i.now)]);
      if (consumed) await tryReleaseTask(t, nt.id, i.now);
      await activity(t, src.id, "handoff.proposed", i.now, { handoff: ho.code, to: to.slug, newTask: nt.code });
      await enqueueNotify(t, `notify:handoff:${ho.id}`, { type: "HANDOFF_PROPOSED", taskCode: nt.code, handoff: ho.code }, i.now);
      await audit(t, "handoff.proposed", i.by.actorRef, { handoffId: ho.id, from: fromAsst?.id ?? null, to: to.id, depth }, i.now);
      return { handoff: ho, task: nt, alreadyProcessed: false as const };
    });
    if ("refused" in res) throw new LumiError("CHECK_FAILED", 422, { reasons: res.refused });
    return res;
  } catch (e) {
    throw uniqueViolation(e, [["lumi_handoffs_new_task_uq", "ALREADY_HANDED_OFF"]]) ?? e;
  }
}

/** The RECEIVING bot answers inside its own run: ACCEPT, REJECT with a reason, or NEED_INFO. The state machine allows each answer once per round. */
export async function respondHandoff(db: Db, a: { botAssistantId: string; actorRef: string; handoffCode: string; decision: "ACCEPT" | "REJECT" | "NEED_INFO"; text?: string; now: Date }) {
  if (a.decision !== "ACCEPT" && (a.text ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["text(lý do/câu hỏi)"] });
  return db.tx(async (t) => {
    const [ho] = await t.query<any>(`SELECT * FROM lumi_handoffs WHERE code=$1 FOR UPDATE`, [a.handoffCode]);
    if (!ho) throw new LumiError("NOT_FOUND", 404);
    if (ho.to_assistant_id !== a.botAssistantId) throw new LumiError("FORBIDDEN", 403);
    const target = a.decision === "ACCEPT" ? "ACCEPTED" : a.decision === "REJECT" ? "REJECTED" : "NEEDS_INFO";
    if (ho.state === target) return { handoff: ho, alreadyProcessed: true as const };
    if (ho.state !== "PROPOSED") throw new LumiError("INVALID_TRANSITION", 409, { state: ho.state });
    const maxRounds = Number((await requirePolicy(t, "handoff_max_rounds")).value);
    let state = target; let round = ho.round;
    if (a.decision === "NEED_INFO") { round += 1; if (round > maxRounds) state = "ESCALATED"; }
    await t.query(`UPDATE lumi_handoffs SET state=$2,round=$3,reason=$4,decided_at=$5 WHERE id=$1`, [ho.id, state, round, a.text ?? null, iso(a.now)]);
    await t.query(`INSERT INTO lumi_handoff_events(handoff_id,event_type,actor_ref,text,created_at) VALUES ($1,$2,$3,$4,$5)`, [ho.id, state === "ESCALATED" ? "ESCALATED" : target, a.actorRef, a.text ?? null, iso(a.now)]);
    if (state !== "ACCEPTED") {
      await dropPendingRuns(t, ho.new_task_id, a.now, "handoff " + state.toLowerCase());
      await t.query(`UPDATE tasks SET status='ON_HOLD',hold_reason=$2,needs_decision=true,updated_at=$3 WHERE id=$1`, [ho.new_task_id, target === "REJECTED" ? "HANDOFF_REJECTED" : "HANDOFF_INFO", iso(a.now)]);
      await enqueueNotify(t, `notify:handoff-${state}:${ho.id}:${round}`, { type: "HANDOFF_NEEDS_OWNER", handoff: ho.code, state }, a.now);
    }
    await activity(t, ho.new_task_id, `handoff.${state.toLowerCase()}`, a.now, { handoff: ho.code, text: a.text ?? null });
    await audit(t, `handoff.${state.toLowerCase()}`, a.actorRef, { handoffId: ho.id }, a.now);
    const [row] = await t.query<any>(`SELECT * FROM lumi_handoffs WHERE id=$1`, [ho.id]);
    return { handoff: row, alreadyProcessed: false as const };
  });
}

/** The owner supplies the missing information (or decides after a rejection) and the receiver's task is released again. */
export async function answerHandoff(db: Db, a: { actorRef: string; handoffId: string; text: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if ((a.text ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["text"] });
  return db.tx(async (t) => {
    const [ho] = await t.query<any>(`SELECT * FROM lumi_handoffs WHERE id=$1 FOR UPDATE`, [a.handoffId]);
    if (!ho) throw new LumiError("NOT_FOUND", 404);
    if (!["NEEDS_INFO", "ESCALATED"].includes(ho.state)) throw new LumiError("INVALID_TRANSITION", 409, { state: ho.state });
    await t.query(`UPDATE lumi_handoffs SET state='PROPOSED',reason=NULL WHERE id=$1`, [ho.id]);
    await t.query(`INSERT INTO lumi_handoff_events(handoff_id,event_type,actor_ref,text,created_at) VALUES ($1,'INFO_PROVIDED',$2,$3,$4)`, [ho.id, a.actorRef, a.text.trim(), iso(a.now)]);
    await t.query(`UPDATE tasks SET description=coalesce(description,'')||E'\\n\\n[Bổ sung từ Chủ] '||$2,hold_reason='WAITING_DEPENDENCY',needs_decision=false,updated_at=$3 WHERE id=$1`, [ho.new_task_id, a.text.trim(), iso(a.now)]);
    const released = await tryReleaseTask(t, ho.new_task_id, a.now);
    await audit(t, "handoff.info_provided", a.actorRef, { handoffId: ho.id }, a.now);
    return { released };
  });
}

export async function cancelHandoff(db: Db, a: { actorRef: string; handoffId: string; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if ((a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  return db.tx(async (t) => {
    const [ho] = await t.query<any>(`SELECT * FROM lumi_handoffs WHERE id=$1 FOR UPDATE`, [a.handoffId]);
    if (!ho) throw new LumiError("NOT_FOUND", 404);
    if (ho.state === "CANCELLED") return { alreadyProcessed: true as const };
    const [k] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [ho.new_task_id]);
    if (k && !["ON_HOLD", "QUEUED", "WAITING_ASSISTANT", "CAPTURED", "REJECTED", "FAILED"].includes(k.status)) throw new LumiError("INVALID_TRANSITION", 409, { status: k.status });
    if ((await t.query(`SELECT 1 FROM lumi_task_runs WHERE task_id=$1 AND state = ANY($2::text[])`, [ho.new_task_id, IN_FLIGHT])).length) throw new LumiError("RUN_ACTIVE", 409);
    await dropPendingRuns(t, ho.new_task_id, a.now, "handoff cancelled");
    await t.query(`UPDATE tasks SET status='CANCELLED',hold_reason=NULL,needs_decision=false,updated_at=$2 WHERE id=$1`, [ho.new_task_id, iso(a.now)]);
    await t.query(`UPDATE lumi_handoffs SET state='CANCELLED',reason=$2,decided_at=$3 WHERE id=$1`, [ho.id, a.reason, iso(a.now)]);
    await t.query(`INSERT INTO lumi_handoff_events(handoff_id,event_type,actor_ref,text,created_at) VALUES ($1,'CANCELLED',$2,$3,$4)`, [ho.id, a.actorRef, a.reason, iso(a.now)]);
    await audit(t, "handoff.cancelled", a.actorRef, { handoffId: ho.id }, a.now);
    return { alreadyProcessed: false as const };
  });
}

// ───────────────────────── PM bot change proposals (OFC-05)
export async function setProjectPmAuto(db: Db, a: { actorRef: string; projectId: string; on: boolean; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const r = await db.query<any>(`UPDATE lumi_projects SET pm_auto_reassign=$2 WHERE id=$1 RETURNING id`, [a.projectId, a.on]);
  if (!r.length) throw new LumiError("NOT_FOUND", 404);
  await audit(db, "project.pm_auto_reassign", a.actorRef, { projectId: a.projectId, on: a.on }, a.now);
}

export async function proposeReassign(db: Db, a: { pmAssistantId: string; actorRef: string; taskCode: string; toAssistantId: string; reason: string; idempotencyKey: string; now: Date }) {
  if ((a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  try {
    return await db.tx(async (t) => {
      const [prior] = await t.query<any>(`SELECT * FROM lumi_change_proposals WHERE idempotency_key=$1`, [a.idempotencyKey]);
      if (prior) return { proposal: prior, alreadyProcessed: true as const };
      const [k] = await t.query<any>(`SELECT * FROM tasks WHERE code=$1`, [a.taskCode]);
      if (!k || !k.project_id) throw new LumiError("NOT_FOUND", 404, { what: "task" });
      const [pj] = await t.query<any>(`SELECT * FROM lumi_projects WHERE id=$1`, [k.project_id]);
      if (!pj || pj.pm_assistant_id !== a.pmAssistantId) throw new LumiError("NOT_PM", 403); // only the PM of THIS project proposes changes for it
      const [pm] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.pmAssistantId]);
      if (!canInitiateInternal(pm.execution_level)) throw new LumiError("LEVEL_TOO_LOW", 403, { level: pm.execution_level, needs: 2 });
      if (!(await t.query(`SELECT 1 FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [a.toAssistantId])).length) throw new LumiError("NOT_FOUND", 404, { what: "assignee" });
      const [row] = await t.query<any>(
        `INSERT INTO lumi_change_proposals(idempotency_key,project_id,task_id,to_assistant_id,reason,proposed_by_assistant_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [a.idempotencyKey, pj.id, k.id, a.toAssistantId, a.reason.trim(), a.pmAssistantId, iso(a.now)]);
      await audit(t, "change.proposed", a.actorRef, { proposalId: row.id, taskId: k.id }, a.now);
      if (pj.pm_auto_reassign) {
        // the owner explicitly allowed automatic application for this project
        try {
          await reassignTaskTx(t, { taskId: k.id, toAssistantId: a.toAssistantId, actorRef: a.actorRef, reason: `PM bot: ${a.reason.trim()}`, now: a.now });
          await t.query(`UPDATE lumi_change_proposals SET state='APPLIED',decided_by='auto:pm_auto_reassign',decided_at=$2,result='Đã áp dụng tự động (Chủ cho phép cho dự án này)' WHERE id=$1`, [row.id, iso(a.now)]);
        } catch (e) {
          if (!(e instanceof LumiError)) throw e;
          await t.query(`UPDATE lumi_change_proposals SET state='FAILED',decided_by='auto:pm_auto_reassign',decided_at=$2,result=$3 WHERE id=$1`, [row.id, iso(a.now), `Không áp dụng được: ${e.code}`]);
        }
      } else await enqueueNotify(t, `notify:change:${row.id}`, { type: "CHANGE_PROPOSED", taskCode: k.code }, a.now);
      const [out] = await t.query<any>(`SELECT * FROM lumi_change_proposals WHERE id=$1`, [row.id]);
      return { proposal: out, alreadyProcessed: false as const };
    });
  } catch (e) {
    throw uniqueViolation(e, [["idempotency_key", "ALREADY_PROPOSED"]]) ?? e;
  }
}

export async function decideChange(db: Db, a: { actorRef: string; proposalId: string; decision: "APPROVE" | "REJECT"; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [p] = await t.query<any>(`SELECT * FROM lumi_change_proposals WHERE id=$1 FOR UPDATE`, [a.proposalId]);
    if (!p) throw new LumiError("NOT_FOUND", 404);
    const want = a.decision === "APPROVE" ? ["APPLIED", "FAILED"] : ["REJECTED"];
    if (want.includes(p.state)) return { proposal: p, alreadyProcessed: true as const };
    if (p.state !== "PENDING") throw new LumiError("INVALID_TRANSITION", 409, { state: p.state });
    if (a.decision === "REJECT") await t.query(`UPDATE lumi_change_proposals SET state='REJECTED',decided_by=$2,decided_at=$3 WHERE id=$1`, [p.id, a.actorRef, iso(a.now)]);
    else {
      try {
        await reassignTaskTx(t, { taskId: p.task_id, toAssistantId: p.to_assistant_id, actorRef: a.actorRef, reason: `PM bot (được Chủ duyệt): ${p.reason}`, now: a.now });
        await t.query(`UPDATE lumi_change_proposals SET state='APPLIED',decided_by=$2,decided_at=$3,result='Đã áp dụng' WHERE id=$1`, [p.id, a.actorRef, iso(a.now)]);
      } catch (e) {
        if (!(e instanceof LumiError)) throw e;
        await t.query(`UPDATE lumi_change_proposals SET state='FAILED',decided_by=$2,decided_at=$3,result=$4 WHERE id=$1`, [p.id, a.actorRef, iso(a.now), `Không áp dụng được: ${e.code}`]);
      }
    }
    await audit(t, `change.${a.decision.toLowerCase()}`, a.actorRef, { proposalId: p.id }, a.now);
    const [row] = await t.query<any>(`SELECT * FROM lumi_change_proposals WHERE id=$1`, [p.id]);
    return { proposal: row, alreadyProcessed: false as const };
  });
}

// ───────────────────────── read model for the task panel and the approvals tab
export async function taskCoordination(db: Db, taskId: string) {
  const deps = await db.query<any>(`SELECT u.id,u.code,u.title,u.status::text AS status,d.consumed_version,d.stale FROM lumi_task_deps d JOIN tasks u ON u.id=d.depends_on_task_id WHERE d.task_id=$1 ORDER BY u.code`, [taskId]);
  const dependents = await db.query<any>(`SELECT x.id,x.code,x.title,x.status::text AS status,d.stale FROM lumi_task_deps d JOIN tasks x ON x.id=d.task_id WHERE d.depends_on_task_id=$1 ORDER BY x.code`, [taskId]);
  const handoffs = await db.query<any>(
    `SELECT ho.id,ho.code,ho.state,ho.depth,ho.round,ho.reason,ho.ticket,ho.created_at,fa.name AS from_name,ta.name AS to_name,ho.new_task_id,ho.source_task_id,
            (SELECT coalesce(json_agg(json_build_object('type',e.event_type,'actor',e.actor_ref,'text',e.text,'at',e.created_at) ORDER BY e.created_at),'[]'::json) FROM lumi_handoff_events e WHERE e.handoff_id=ho.id) AS events
       FROM lumi_handoffs ho LEFT JOIN lumi_assistants fa ON fa.id=ho.from_assistant_id JOIN lumi_assistants ta ON ta.id=ho.to_assistant_id
      WHERE ho.new_task_id=$1 OR ho.source_task_id=$1 ORDER BY ho.created_at`, [taskId]);
  const [k] = await db.query<any>(`SELECT t.required_skill,t.role_id,r.name AS role_name,r.code AS role_code,t.owner_assistant_id FROM tasks t LEFT JOIN lumi_roles r ON r.id=t.role_id WHERE t.id=$1`, [taskId]);
  let skill: any = null;
  if (k?.required_skill && k.owner_assistant_id) [skill] = await db.query<any>(`SELECT state,evidence,assessed_at FROM lumi_skills WHERE assistant_id=$1 AND lower(skill)=lower($2)`, [k.owner_assistant_id, k.required_skill]);
  return { deps, dependents, handoffs, role: k?.role_id ? { id: k.role_id, name: k.role_name, code: k.role_code } : null, required_skill: k?.required_skill ?? null, skill_state: k?.required_skill ? (skill?.state ?? "UNVERIFIED") : null };
}

export async function listChangeProposals(db: Db) {
  return db.query<any>(
    `SELECT c.id,c.state,c.reason,c.result,c.created_at,c.decided_by,t.code AS task_code,t.title AS task_title,p.name AS project_name,p.slug AS project_slug,
            ta.name AS to_name,pa.name AS proposed_by
       FROM lumi_change_proposals c JOIN tasks t ON t.id=c.task_id JOIN lumi_projects p ON p.id=c.project_id JOIN lumi_assistants ta ON ta.id=c.to_assistant_id JOIN lumi_assistants pa ON pa.id=c.proposed_by_assistant_id
      ORDER BY (c.state='PENDING') DESC, c.created_at DESC LIMIT 100`);
}
