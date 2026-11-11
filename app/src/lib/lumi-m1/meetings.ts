/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-04 asynchronous meetings (MTG-01..03, 05..09). A meeting is an EXCEPTION with a stated reason, not a default step: work that has one clear owner and
 * enough input goes through a structured handoff (PLN-06), not a meeting. Every party gets the question and a deadline, submits a structured contribution
 * (no free chat), and the chair synthesises ONE immutable, versioned note whose every line points to the original contributions.
 * The APP, not the chair, classifies each conclusion: a record, an internal decision inside the approved plan, or a proposal that needs the owner.
 * A conclusion never widens a budget or a permission. Silence is not agreement. Limits (rounds, runs, cost, time) stop a meeting without asking for more.
 */
import { audit, createRun, enqueueNotify, LumiError, requireRole, type Db } from "./core";
import { createTaskInTx } from "./core-web";
import { checkReceiver, dropPendingRuns, reassignTaskTx } from "./coordination";
import { canInitiateInternal } from "./levels";
import { requirePolicy } from "./policies";
import { planLimits } from "./plans";
import { proposeKnowledge } from "./knowledge";
import { uniqueViolation } from "./assistants";
import { normalizeText } from "./knowledge-pack";

const iso = (d: Date) => d.toISOString();
export const REASONS = ["CROSS_ROLE", "JOINT_PLAN", "MILESTONE", "OWNER"] as const;
export const ROLES = ["CHAIR", "REQUIRED_EXPERT", "CONTRIBUTOR", "OBSERVER", "OWNER_OPTIONAL"] as const;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_DAYS = 14;

export type ConclusionType = "RECORD" | "ACTION_ITEM" | "REASSIGN_TASK" | "BUDGET_CHANGE" | "GRANT_REQUEST" | "SCOPE_CHANGE" | "EXTERNAL_COMMITMENT" | "KNOWLEDGE";
/** What each type may become. Anything touching money, permissions, scope, outside commitments or lasting knowledge is ALWAYS a proposal for the owner. */
export const ALWAYS_PROPOSAL: ConclusionType[] = ["BUDGET_CHANGE", "GRANT_REQUEST", "SCOPE_CHANGE", "EXTERNAL_COMMITMENT", "KNOWLEDGE"];
const TYPES: ConclusionType[] = ["RECORD", "ACTION_ITEM", "REASSIGN_TASK", ...ALWAYS_PROPOSAL];

export interface OpenInput {
  actorRef: string; assistantId?: string; idempotencyKey: string; title: string; question: string; reason: (typeof REASONS)[number];
  planId?: string; projectId?: string; chairAssistantId: string; backupChairAssistantId?: string;
  participants: { assistantId?: string; owner?: boolean; role: (typeof ROLES)[number]; expertise?: string }[];
  closesAt: Date; maxRounds: number; maxRuns: number; maxCost?: number; currency?: string; endConditions: string;
  inputs: { kind: "PLAN_VERSION" | "OUTPUT" | "KNOWLEDGE"; ref: string; version: number }[]; now: Date;
}

async function resolveInputs(t: Db, inputs: OpenInput["inputs"]) {
  const out: any[] = []; const bad: string[] = [];
  for (const [i, x] of (inputs ?? []).entries()) {
    let ok = false; let label = x.ref;
    if (x.kind === "PLAN_VERSION") { const r = await t.query<any>(`SELECT p.code FROM lumi_plan_versions v JOIN lumi_plans p ON p.id=v.plan_id WHERE p.code=$1 AND v.version=$2`, [x.ref, x.version]); ok = !!r[0]; label = `${x.ref} v${x.version}`; }
    else if (x.kind === "OUTPUT") { const r = await t.query<any>(`SELECT t.code FROM lumi_task_outputs o JOIN tasks t ON t.id=o.task_id WHERE t.code=$1 AND o.version=$2`, [x.ref, x.version]); ok = !!r[0]; label = `${x.ref} bản ${x.version}`; }
    else if (x.kind === "KNOWLEDGE") { const r = await t.query<any>(`SELECT i.code FROM lumi_knowledge_versions v JOIN lumi_knowledge_items i ON i.id=v.item_id WHERE i.code=$1 AND v.version=$2`, [x.ref, x.version]); ok = !!r[0]; label = `${x.ref} v${x.version}`; }
    if (!ok) bad.push(`inputs[${i}](cần đối tượng có thật kèm số phiên bản)`);
    out.push({ kind: x.kind, ref: x.ref, version: x.version, label });
  }
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return out;
}

// ───────────────────────── open (MTG-01, 02, 09)
export async function openMeeting(db: Db, i: OpenInput) {
  const isBot = i.actorRef.startsWith("bot:");
  if (!isBot) await requireRole(db, i.actorRef, ["OWNER"]); // people: the owner opens meetings (plan leads and bots go through their own run)
  const bad: string[] = [];
  if (typeof i.idempotencyKey !== "string" || i.idempotencyKey.length < 8) bad.push("idempotency_key");
  if (typeof i.title !== "string" || i.title.trim().length < 3 || i.title.length > 200) bad.push("title(3..200)");
  if (typeof i.question !== "string" || i.question.trim().length < 3 || i.question.length > 4000) bad.push("question(mục tiêu/câu hỏi cần trả lời, 3..4000)");
  if (!REASONS.includes(i.reason)) bad.push("reason(CROSS_ROLE|JOINT_PLAN|MILESTONE|OWNER)");
  if (!i.chairAssistantId) bad.push("chair(chủ trì)");
  if (!Number.isInteger(i.maxRounds) || i.maxRounds < 1 || i.maxRounds > 5) bad.push("max_rounds(1..5)");
  if (!Number.isInteger(i.maxRuns) || i.maxRuns < 1 || i.maxRuns > 50) bad.push("max_runs(1..50)");
  if (i.maxCost !== undefined && (!(i.maxCost >= 0) || !i.currency)) bad.push("max_cost(>=0, kèm currency)");
  if (typeof i.endConditions !== "string" || i.endConditions.trim().length < 3) bad.push("end_conditions");
  if (!(i.closesAt instanceof Date) || Number.isNaN(i.closesAt.getTime()) || i.closesAt.getTime() <= i.now.getTime() || i.closesAt.getTime() > i.now.getTime() + MAX_DAYS * 86400_000) bad.push(`closes_at(sau bây giờ, tối đa ${MAX_DAYS} ngày)`);
  if (!Array.isArray(i.inputs) || i.inputs.length < 1) bad.push("inputs(>=1 đầu vào có phiên bản)");
  if (Array.isArray(i.inputs) && i.inputs.length > 10) bad.push("inputs(<=10)");
  if (Array.isArray(i.participants) && i.participants.length > 12) bad.push("participants(<=12)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  try {
    return await db.tx(async (t) => {
      await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`meeting-open:${i.idempotencyKey}`]); // concurrent opens with one key: the loser waits, then sees the winner's meeting
      const [prior] = await t.query<any>(`SELECT * FROM lumi_meetings WHERE idempotency_key=$1`, [i.idempotencyKey]);
      if (prior) return { meeting: prior, alreadyProcessed: true as const };
      let plan: any = null; let projectId = i.projectId ?? null;
      if (i.planId) {
        [plan] = await t.query<any>(`SELECT p.*, g.project_id FROM lumi_plans p JOIN lumi_goals g ON g.id=p.goal_id WHERE p.id=$1`, [i.planId]);
        if (!plan) throw new LumiError("NOT_FOUND", 404, { what: "plan" });
        projectId = plan.project_id;
      }
      if (!projectId) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["plan_id|project_id"] });
      if (i.reason !== "OWNER" && !plan) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["plan_id(họp không do Chủ yêu cầu phải thuộc một kế hoạch)"] });
      // the owner's per-plan ceiling on meetings; not set ⇒ blocked
      if (plan) {
        const cap = Number((await requirePolicy(t, "meeting_cap")).value);
        const [{ n }] = await t.query<any>(`SELECT count(*)::int AS n FROM lumi_meetings WHERE plan_id=$1 AND state<>'CANCELLED'`, [plan.id]);
        if (n >= cap) throw new LumiError("MEETING_CAP", 409, { cap, used: n });
      }
      if (isBot) {
        const [me] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [i.assistantId]);
        if (!me || !plan || !canInitiateInternal(me.execution_level) || (plan.lead_assistant_id !== me.id && !(await t.query(`SELECT 1 FROM tasks WHERE plan_id=$1 AND owner_assistant_id=$2`, [plan.id, me.id])).length)) throw new LumiError("FORBIDDEN", 403);
        if (i.reason === "OWNER") throw new LumiError("FORBIDDEN", 403); // only the owner can call an owner-requested meeting
      }
      // participants and their roles
      const parts: { assistantId: string | null; owner: boolean; role: string; expertise: string | null }[] = [{ assistantId: i.chairAssistantId, owner: false, role: "CHAIR", expertise: null }];
      for (const p of i.participants ?? []) {
        if (!ROLES.includes(p.role) || p.role === "CHAIR") throw new LumiError("VALIDATION_ERROR", 400, { errors: ["participants.role"] });
        if (p.owner) { if (p.role !== "OWNER_OPTIONAL") throw new LumiError("VALIDATION_ERROR", 400, { errors: ["participants(Chủ chỉ có vai OWNER_OPTIONAL)"] }); parts.push({ assistantId: null, owner: true, role: p.role, expertise: null }); continue; }
        if (!p.assistantId || p.assistantId === i.chairAssistantId) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["participants.assistant_id"] });
        if (p.role === "REQUIRED_EXPERT" && (p.expertise ?? "").trim().length < 2) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["participants.expertise(chuyên môn bắt buộc)"] });
        if (parts.some((x) => x.assistantId === p.assistantId)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["participants(trùng người)"] });
        parts.push({ assistantId: p.assistantId, owner: false, role: p.role, expertise: p.expertise?.trim() ?? null });
      }
      const botIds = parts.filter((p) => p.assistantId).map((p) => p.assistantId!);
      const asst = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id = ANY($1::uuid[]) AND status='ACTIVE'`, [[...botIds, ...(i.backupChairAssistantId ? [i.backupChairAssistantId] : [])]]);
      for (const id of [...botIds, ...(i.backupChairAssistantId ? [i.backupChairAssistantId] : [])]) if (!asst.some((a: any) => a.id === id)) throw new LumiError("NOT_FOUND", 404, { what: "assistant" });
      // MTG-01: a meeting needs real disagreement or joint input between at least TWO bots, unless the owner called it
      const speakers = parts.filter((p) => p.assistantId && p.role !== "OBSERVER");
      if (i.reason !== "OWNER" && speakers.length < 2) throw new LumiError("USE_HANDOFF", 422, { message: "Chỉ có một bot tham gia phát biểu: việc có một PIC rõ đi thẳng bàn giao có cấu trúc, không họp." });
      const inputs = await resolveInputs(t, i.inputs);
      const runsPlanned = speakers.length + 1; // one contribution run per speaking bot + one synthesis run by the chair
      if (runsPlanned > i.maxRuns) throw new LumiError("VALIDATION_ERROR", 400, { errors: [`max_runs(cần tối thiểu ${runsPlanned} lượt cho ${speakers.length} bot và lượt tổng hợp)`] });
      const [m] = await t.query<any>(
        `INSERT INTO lumi_meetings(code,idempotency_key,title,question,reason,plan_id,project_id,chair_assistant_id,backup_chair_assistant_id,opens_at,closes_at,max_rounds,max_runs,max_cost,currency,end_conditions,inputs,created_by,created_at)
         VALUES ('MT-'||lpad(nextval('lumi_meeting_code_seq')::text,3,'0'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$9) RETURNING *`,
        [i.idempotencyKey, i.title.trim(), i.question.trim(), i.reason, plan?.id ?? null, projectId, i.chairAssistantId, i.backupChairAssistantId ?? null, iso(i.now), iso(i.closesAt), i.maxRounds, i.maxRuns, i.maxCost ?? null, i.currency ?? null, i.endConditions.trim(), JSON.stringify(inputs), i.actorRef]);
      let runs = 0;
      for (const p of parts) {
        const [row] = await t.query<any>(`INSERT INTO lumi_meeting_participants(meeting_id,assistant_id,actor_ref,role,expertise) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [m.id, p.assistantId, p.owner ? i.actorRef : null, p.role, p.expertise]);
        if (p.assistantId && p.role !== "OBSERVER") {
          const task = (await createTaskInTx(t, {
            actorRef: "system:meeting", clientRequestId: `meeting-${m.id}-${row.id}`, projectId: projectId!, assigneeId: p.assistantId, title: `Họp ${m.code}: đóng góp ý kiến`, now: i.now,
            description: contributionBrief(m, inputs, p), expectedOutput: "Một đóng góp có cấu trúc gửi bằng công cụ meeting_contribute",
            ...(plan ? { plan: { planId: plan.id, planVersion: null, planTaskKey: null, acceptance: null, sourceKey: `meeting:${m.id}:contrib:${row.id}`, source: "MEETING" } } : {}),
          })).task;
          await t.query(`UPDATE lumi_meeting_participants SET task_id=$2 WHERE id=$1`, [row.id, task.id]);
          runs += 1;
        }
      }
      await t.query(`UPDATE lumi_meetings SET runs_used=$2 WHERE id=$1`, [m.id, runs]);
      await audit(t, "meeting.opened", i.actorRef, { meetingId: m.id, code: m.code, reason: i.reason }, i.now);
      return { meeting: { ...m, runs_used: runs }, alreadyProcessed: false as const };
    });
  } catch (e) { throw uniqueViolation(e, [["lumi_meetings_idempotency_key_key", "IDEMPOTENT_RACE"]]) ?? e; }
}

function contributionBrief(m: any, inputs: any[], p: { role: string; expertise: string | null }): string {
  return [
    `Cuộc họp bất đồng bộ ${m.code}: ${m.title}`,
    `Câu hỏi cần trả lời: ${m.question}`,
    `Vai của bạn: ${p.role}${p.expertise ? ` (ý kiến chuyên môn bắt buộc: ${p.expertise})` : ""}. Hạn: ${iso(new Date(m.closes_at))}. Tối đa ${m.max_rounds} vòng.`,
    `Đầu vào (đúng phiên bản): ${inputs.map((x) => x.label).join("; ")}`,
    `Điều kiện kết thúc: ${m.end_conditions}`,
    `CÁCH LÀM: đọc đầu vào, rồi gọi công cụ meeting_contribute(run_id, stance, evidence, risks, estimate, objection, proposal) ĐÚNG MỘT LẦN. Không nhắn trực tiếp cho bot khác. Chỉ nêu điều bạn có bằng chứng; nếu thiếu thông tin hãy nói rõ. Đóng góp muộn hoặc im lặng KHÔNG được coi là đồng ý.`,
  ].join("\n");
}

// ───────────────────────── contribute (MTG-03)
export async function contribute(db: Db, a: { meetingCode: string; actorRef: string; assistantId?: string; round?: number; stance: string; evidence?: string; risks?: string; estimate?: string; objection?: string; proposal?: string; now: Date }) {
  const isBot = a.actorRef.startsWith("bot:");
  if (!isBot) await requireRole(db, a.actorRef, ["OWNER"]);
  if (typeof a.stance !== "string" || a.stance.trim().length < 3 || a.stance.length > 4000) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["stance(lập trường, 3..4000)"] });
  return db.tx(async (t) => {
    const [m] = await t.query<any>(`SELECT * FROM lumi_meetings WHERE code=$1 FOR UPDATE`, [a.meetingCode]);
    if (!m) throw new LumiError("NOT_FOUND", 404);
    const [p] = await t.query<any>(`SELECT * FROM lumi_meeting_participants WHERE meeting_id=$1 AND ${isBot ? "assistant_id=$2" : "actor_ref=$2"}`, [m.id, isBot ? a.assistantId : a.actorRef]);
    if (!p || p.role === "OBSERVER") throw new LumiError("FORBIDDEN", 403); // not invited, or an observer: no contribution
    const round = a.round ?? 1;
    if (!Number.isInteger(round) || round < 1 || round > m.max_rounds) throw new LumiError("ROUND_LIMIT", 409, { max_rounds: m.max_rounds });
    const [dup] = await t.query<any>(`SELECT * FROM lumi_meeting_contributions WHERE meeting_id=$1 AND participant_id=$2 AND round=$3`, [m.id, p.id, round]);
    if (dup) return { contribution: dup, late: dup.late, alreadyProcessed: true as const };
    // after the deadline or once the meeting is closed a contribution is STORED as late and never changes a recorded conclusion
    const late = m.state !== "OPEN" || a.now.getTime() > new Date(m.closes_at).getTime();
    const [c] = await t.query<any>(
      `INSERT INTO lumi_meeting_contributions(meeting_id,participant_id,round,stance,evidence,risks,estimate,objection,proposal,late,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [m.id, p.id, round, a.stance.trim(), a.evidence ?? null, a.risks ?? null, a.estimate ?? null, a.objection ?? null, a.proposal ?? null, late, iso(a.now)]);
    if (!late) await t.query(`UPDATE lumi_meeting_participants SET state='CONTRIBUTED' WHERE id=$1 AND state='INVITED'`, [p.id]);
    await audit(t, late ? "meeting.contribution_late" : "meeting.contribution", a.actorRef, { meetingId: m.id, participantId: p.id, round }, a.now);
    return { contribution: c, late, alreadyProcessed: false as const };
  });
}

// ───────────────────────── required expertise (MTG-05)
/** A required opinion counts only when a participant of that expertise contributed in time AND is not just a headcount: the bot must hold the skill as VERIFIED (ORG-05). */
export async function requiredCoverage(t: Db, meetingId: string) {
  const req = await t.query<any>(`SELECT p.id,p.assistant_id,p.expertise,p.state FROM lumi_meeting_participants p WHERE p.meeting_id=$1 AND p.role='REQUIRED_EXPERT'`, [meetingId]);
  const out: { expertise: string; participant_id: string; present: boolean; verified: boolean; satisfied: boolean }[] = [];
  for (const r of req) {
    const present = (await t.query(`SELECT 1 FROM lumi_meeting_contributions WHERE participant_id=$1 AND late=false`, [r.id])).length > 0;
    const verified = (await t.query(`SELECT 1 FROM lumi_skills WHERE assistant_id=$1 AND lower(skill)=lower($2) AND state IN ('VERIFIED','MONITORED')`, [r.assistant_id, r.expertise])).length > 0;
    out.push({ expertise: r.expertise, participant_id: r.id, present, verified, satisfied: present && verified });
  }
  return out;
}

// ───────────────────────── synthesis (MTG-05..08)
export interface NoteLine { text: string; contribution_ids: string[] }
export interface ConclusionInput { type: ConclusionType; text: string; depends_on_expertise?: string; payload?: any }
export async function synthesizeMeeting(db: Db, a: { meetingCode: string; actorRef: string; assistantId?: string; summary: string; lines: NoteLine[]; conclusions: ConclusionInput[]; now: Date }) {
  const isBot = a.actorRef.startsWith("bot:");
  if (!isBot) await requireRole(db, a.actorRef, ["OWNER"]);
  const bad: string[] = [];
  if (typeof a.summary !== "string" || a.summary.trim().length < 3 || a.summary.length > 6000) bad.push("summary(3..6000)");
  if (!Array.isArray(a.lines) || a.lines.some((l) => typeof l?.text !== "string" || l.text.trim().length < 3 || !Array.isArray(l.contribution_ids) || l.contribution_ids.length < 1)) bad.push("lines(mỗi dòng cần text và ít nhất một đóng góp gốc)");
  if (!Array.isArray(a.conclusions) || a.conclusions.some((c) => !TYPES.includes(c?.type) || typeof c?.text !== "string" || c.text.trim().length < 3)) bad.push(`conclusions(type một trong ${TYPES.join("/")}, kèm text)`);
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    const [m] = await t.query<any>(`SELECT * FROM lumi_meetings WHERE code=$1 FOR UPDATE`, [a.meetingCode]);
    if (!m) throw new LumiError("NOT_FOUND", 404);
    if (isBot && a.assistantId !== m.chair_assistant_id) throw new LumiError("FORBIDDEN", 403); // only the chair (or, after a switch, the backup chair) synthesises
    if (m.state !== "OPEN") throw new LumiError("INVALID_TRANSITION", 409, { state: m.state });
    const cov = await requiredCoverage(t, m.id);
    const ready = cov.every((c) => c.present) || a.now.getTime() >= new Date(m.closes_at).getTime() || !isBot;
    if (!ready) throw new LumiError("NOT_READY", 409, { missing: cov.filter((c) => !c.present).map((c) => c.expertise) });
    const all = await t.query<any>(`SELECT c.id,c.late,p.assistant_id FROM lumi_meeting_contributions c JOIN lumi_meeting_participants p ON p.id=c.participant_id WHERE c.meeting_id=$1`, [m.id]);
    const byId = new Map(all.map((c: any) => [c.id, c]));
    for (const l of a.lines) for (const id of l.contribution_ids) if (!byId.has(id)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["lines.contribution_ids(phải là đóng góp của cuộc họp này)"] });
    const refs = a.lines.flatMap((l) => l.contribution_ids);
    const own = refs.filter((id) => byId.get(id)?.assistant_id === m.chair_assistant_id).length;
    const selfChecked = refs.length > 0 && own / refs.length >= 0.5; // the chair summarising mostly its own input is labelled, not hidden
    const [{ v }] = await t.query<any>(`SELECT coalesce(max(version),0)+1 AS v FROM lumi_meeting_notes WHERE meeting_id=$1`, [m.id]);
    await t.query(`INSERT INTO lumi_meeting_notes(meeting_id,version,summary,lines,self_checked,created_by,created_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`, [m.id, v, a.summary.trim(), JSON.stringify(a.lines), selfChecked, a.actorRef, iso(a.now)]);
    const missing = cov.filter((c) => !c.satisfied);
    let blocked = 0; let pending = 0; let applied = 0;
    for (const [idx, c] of a.conclusions.entries()) {
      const cl = await classify(t, m, c, missing, a.now);
      const [row] = await t.query<any>(
        `INSERT INTO lumi_meeting_conclusions(meeting_id,note_version,idx,kind,type,text,depends_on_expertise,payload,reason,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
        [m.id, v, idx + 1, cl.kind, c.type, c.text.trim(), c.depends_on_expertise ?? null, JSON.stringify(c.payload ?? {}), cl.reason, cl.state, iso(a.now)]);
      if (cl.state === "BLOCKED") blocked += 1; else if (cl.state === "PENDING_OWNER") pending += 1;
      if (cl.kind === "INTERNAL" && cl.state !== "BLOCKED") { const done = await applyInternal(t, m, row, c, a.now); if (done) applied += 1; else { await t.query(`UPDATE lumi_meeting_conclusions SET kind='PROPOSAL',state='PENDING_OWNER',reason=reason||' (không áp dụng được tự động, chuyển Chủ)' WHERE id=$1`, [row.id]); pending += 1; } }
      if (c.type === "KNOWLEDGE" && cl.state === "PENDING_OWNER") await knowledgeProposal(t, m, row, c, a.now);
    }
    const outcome = missing.length || blocked ? "PARTIAL" : "DECIDED";
    await t.query(`UPDATE lumi_meetings SET state='CLOSED',outcome=$2,closed_at=$3,closed_by=$4,close_reason=$5 WHERE id=$1`, [m.id, outcome, iso(a.now), a.actorRef, missing.length ? `Thiếu ý kiến chuyên môn: ${missing.map((x) => x.expertise).join(", ")}` : "Chủ trì đã tổng hợp"]);
    await markAbsent(t, m.id);
    if (pending || missing.length) await enqueueNotify(t, `notify:meeting:${m.id}:${v}`, { type: "MEETING_NEEDS_OWNER", meeting: m.code, outcome }, a.now);
    await audit(t, "meeting.synthesized", a.actorRef, { meetingId: m.id, note: v, outcome, applied, pending, blocked }, a.now);
    return { note_version: v, outcome, self_checked: selfChecked, missing_expertise: missing.map((x) => x.expertise), applied, pending, blocked };
  });
}

async function markAbsent(t: Db, meetingId: string) {
  await t.query(`UPDATE lumi_meeting_participants SET state='ABSENT' WHERE meeting_id=$1 AND state='INVITED' AND role <> 'OBSERVER' AND role <> 'OWNER_OPTIONAL'`, [meetingId]); // silence is NOT agreement
}

/** Deterministic classification (MTG-07). Neither the chair nor a bot can pick the class. */
async function classify(t: Db, m: any, c: ConclusionInput, missing: { expertise: string }[], now: Date): Promise<{ kind: "RECORD" | "INTERNAL" | "PROPOSAL"; state: string; reason: string }> {
  if (c.depends_on_expertise && missing.some((x) => normalizeText(x.expertise) === normalizeText(c.depends_on_expertise!))) return { kind: "PROPOSAL", state: "BLOCKED", reason: `Thiếu ý kiến chuyên môn «${c.depends_on_expertise}»: quyết định phụ thuộc chuyên môn này không được chốt.` };
  if (c.type === "RECORD") return { kind: "RECORD", state: "RECORDED", reason: "Biên bản/ghi nhận, chỉ lưu." };
  if (ALWAYS_PROPOSAL.includes(c.type)) return { kind: "PROPOSAL", state: "PENDING_OWNER", reason: "Liên quan tiền, quyền, phạm vi, cam kết bên ngoài hoặc kiến thức lâu dài: cần Chủ duyệt; kết luận họp không tự có hiệu lực." };
  if (!m.plan_id) return { kind: "PROPOSAL", state: "PENDING_OWNER", reason: "Cuộc họp không thuộc kế hoạch đã duyệt nên không có biên nội bộ." };
  const [plan] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1`, [m.plan_id]);
  if (plan?.status !== "EXECUTING") return { kind: "PROPOSAL", state: "PENDING_OWNER", reason: `Kế hoạch đang ở trạng thái ${plan?.status ?? "?"}, chỉ kế hoạch đang thực hiện mới có biên nội bộ.` };
  const p = c.payload ?? {};
  if (c.type === "ACTION_ITEM") {
    const miss = ["item_key", "title", "pic_slug", "due_in_days", "expected_output", "acceptance"].filter((k) => p[k] === undefined || p[k] === null || p[k] === "");
    if (miss.length || !KEY_RE.test(String(p.item_key ?? ""))) return { kind: "PROPOSAL", state: "BLOCKED", reason: `Nhiệm vụ sau họp thiếu: ${miss.join(", ") || "item_key hợp lệ"} (cần PIC, hạn, đầu ra, tiêu chí đạt): không tạo.` };
    if (p.budget_ref) return { kind: "PROPOSAL", state: "PENDING_OWNER", reason: "Nhiệm vụ có tham chiếu ngân sách/quyền: cần Chủ duyệt." };
    const [pic] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE slug=$1`, [p.pic_slug]);
    if (!pic || pic.status !== "ACTIVE") return { kind: "PROPOSAL", state: "BLOCKED", reason: `PIC «${p.pic_slug}» không hoạt động.` };
    const chk = await checkReceiver(t, pic, { now });
    if (!chk.ok) return { kind: "PROPOSAL", state: "PENDING_OWNER", reason: `PIC chưa đủ điều kiện nhận việc (${chk.reasons.map((r) => r.code).join(", ")}): cần Chủ quyết định.` };
    const cap = planLimits().maxTasks;
    const [{ n }] = await t.query<any>(`SELECT count(*)::int AS n FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL`, [plan.id]);
    if (cap !== null && n + 1 > cap) return { kind: "PROPOSAL", state: "PENDING_OWNER", reason: `Thêm việc vượt trần ${cap} việc của kế hoạch: cần Chủ duyệt.` };
    return { kind: "INTERNAL", state: "APPLIED", reason: "Việc nằm trong biên kế hoạch đã duyệt (không tiền/quyền mới, PIC đủ điều kiện, trong trần số việc): ghi lại và thông báo." };
  }
  if (c.type === "REASSIGN_TASK") {
    if (!p.task_code || !p.to_slug) return { kind: "PROPOSAL", state: "BLOCKED", reason: "Đổi PIC thiếu task_code/to_slug." };
    const [task] = await t.query<any>(`SELECT id,plan_id FROM tasks WHERE code=$1`, [p.task_code]);
    const [to] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE slug=$1`, [p.to_slug]);
    if (!task || task.plan_id !== m.plan_id || !to) return { kind: "PROPOSAL", state: "BLOCKED", reason: "Việc hoặc người nhận không thuộc kế hoạch của cuộc họp." };
    const chk = await checkReceiver(t, to, { now });
    if (!chk.ok) return { kind: "PROPOSAL", state: "PENDING_OWNER", reason: `Người nhận chưa đủ điều kiện (${chk.reasons.map((r) => r.code).join(", ")}): cần Chủ quyết định.` };
    return { kind: "INTERNAL", state: "APPLIED", reason: "Đổi PIC giữa bot đủ năng lực trong kế hoạch đã duyệt: ghi lại và thông báo." };
  }
  return { kind: "PROPOSAL", state: "PENDING_OWNER", reason: "Chuyển Chủ." };
}

/** An INTERNAL ACTION_ITEM creates (or LINKS to) a task once, keyed by (meeting, item); the PIC must still accept it. */
async function applyInternal(t: Db, m: any, concl: any, c: ConclusionInput, now: Date): Promise<boolean> {
  const p = c.payload ?? {};
  if (c.type === "REASSIGN_TASK") {
    const [task] = await t.query<any>(`SELECT id FROM tasks WHERE code=$1`, [p.task_code]); const [to] = await t.query<any>(`SELECT id FROM lumi_assistants WHERE slug=$1`, [p.to_slug]);
    try { await reassignTaskTx(t, { taskId: task.id, toAssistantId: to.id, actorRef: "system:meeting", reason: `Quyết định nội bộ trong họp ${m.code}`, now }); return true; } catch { return false; }
  }
  const [pic] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE slug=$1`, [p.pic_slug]);
  const [existing] = await t.query<any>(`SELECT * FROM lumi_meeting_actions WHERE meeting_id=$1 AND item_key=$2`, [m.id, p.item_key]);
  if (existing) return true; // replaying a conclusion never creates a second task
  const [plan] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1`, [m.plan_id]);
  // link to a task that already covers it (same plan, same owner, same title) instead of creating a duplicate
  const link = (await t.query<any>(`SELECT id,title FROM tasks WHERE plan_id=$1 AND owner_assistant_id=$2 AND status::text NOT IN ('CANCELLED','REJECTED')`, [m.plan_id, pic.id])).find((x: any) => normalizeText(x.title) === normalizeText(p.title));
  let taskId: string = link?.id;
  if (!taskId) {
    const due = new Date(now.getTime() + Number(p.due_in_days) * 86400_000);
    const tk = (await createTaskInTx(t, {
      actorRef: "system:meeting", clientRequestId: `meeting-${m.id}-${p.item_key}`, projectId: m.project_id, assigneeId: pic.id, title: p.title, description: p.description ?? c.text, due: iso(due),
      expectedOutput: p.expected_output, now, plan: { planId: plan.id, planVersion: plan.approved_version ?? null, planTaskKey: `mtg-${m.code.toLowerCase()}-${p.item_key}`.slice(0, 40), acceptance: p.acceptance, sourceKey: `meeting:${m.id}:action:${p.item_key}`, source: "MEETING" },
    })).task;
    taskId = tk.id;
    // held until the PIC accepts: no run is sent before the answer
    await dropPendingRuns(t, taskId, now, "meeting action awaiting acceptance");
    await t.query(`UPDATE tasks SET status='ON_HOLD',hold_reason='MEETING_ACCEPT',updated_at=$2 WHERE id=$1`, [taskId, iso(now)]);
  }
  await t.query(`INSERT INTO lumi_meeting_actions(meeting_id,item_key,conclusion_id,title,pic_assistant_id,due_at,expected_output,acceptance,depends_on,budget_ref,task_id,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,'PENDING_ACCEPT',$11) ON CONFLICT (meeting_id,item_key) DO NOTHING`,
    [m.id, p.item_key, concl.id, p.title, pic.id, iso(new Date(now.getTime() + Number(p.due_in_days) * 86400_000)), p.expected_output, p.acceptance, p.depends_on ?? null, taskId, iso(now)]);
  return true;
}

async function knowledgeProposal(t: Db, m: any, concl: any, c: ConclusionInput, now: Date) {
  const p = c.payload ?? {};
  try {
    const r = await proposeKnowledge(t, { actorRef: "system:meeting", kind: p.kind === "DECISION" ? "DECISION" : "RULE", scope: m.project_id ? "PROJECT" : "COMPANY", scopeRef: m.project_id ?? undefined, title: p.title ?? c.text.slice(0, 120), content: p.content ?? c.text, reason: `Kết luận họp ${m.code}`, manualEntry: false, sources: [], now } as any);
    await t.query(`UPDATE lumi_meeting_conclusions SET payload=payload||$2::jsonb WHERE id=$1`, [concl.id, JSON.stringify({ knowledge_item: r.item.code })]);
  } catch { /* the proposal stays a plain conclusion for the owner when it cannot be filed as knowledge */ }
}

// ───────────────────────── owner decisions on proposals / PIC responses
export async function decideConclusion(db: Db, a: { actorRef: string; conclusionId: string; decision: "APPROVE" | "REJECT"; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [c] = await t.query<any>(`SELECT * FROM lumi_meeting_conclusions WHERE id=$1 FOR UPDATE`, [a.conclusionId]);
    if (!c) throw new LumiError("NOT_FOUND", 404);
    const target = a.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (c.state === target) return { conclusion: c, alreadyProcessed: true as const };
    if (c.state !== "PENDING_OWNER") throw new LumiError("INVALID_TRANSITION", 409, { state: c.state });
    await t.query(`UPDATE lumi_meeting_conclusions SET state=$2,decided_by=$3,decided_at=$4 WHERE id=$1`, [c.id, target, a.actorRef, iso(a.now)]);
    // the owner refusing a proposal: tasks that depended on it have not started and stay held
    if (target === "REJECTED") await t.query(`UPDATE lumi_meeting_actions SET state='AWAITING_OWNER' WHERE conclusion_id=$1 AND state='PENDING_ACCEPT'`, [c.id]);
    await audit(t, `meeting.conclusion_${target.toLowerCase()}`, a.actorRef, { conclusionId: c.id }, a.now);
    return { conclusion: (await t.query<any>(`SELECT * FROM lumi_meeting_conclusions WHERE id=$1`, [c.id]))[0], alreadyProcessed: false as const, note: target === "APPROVED" ? "Đồng ý ghi nhận; thay đổi thật (ngân sách, quyền, phạm vi) phải làm ở phiên bản kế hoạch/giấy ủy quyền riêng." : null };
  });
}

/** The PIC answers a post-meeting task: accept (the task is released) or decline with a reason (the plan lead decides inside bounds, or the owner). */
export async function respondAction(db: Db, a: { meetingCode: string; itemKey: string; assistantId: string; actorRef: string; decision: "ACCEPT" | "DECLINE"; reason?: string; now: Date }) {
  if (a.decision === "DECLINE" && (a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  return db.tx(async (t) => {
    const [m] = await t.query<any>(`SELECT * FROM lumi_meetings WHERE code=$1`, [a.meetingCode]);
    const [act] = m ? await t.query<any>(`SELECT * FROM lumi_meeting_actions WHERE meeting_id=$1 AND item_key=$2 FOR UPDATE`, [m.id, a.itemKey]) : [];
    if (!act) throw new LumiError("NOT_FOUND", 404);
    if (act.pic_assistant_id !== a.assistantId) throw new LumiError("FORBIDDEN", 403);
    const target = a.decision === "ACCEPT" ? "ACCEPTED" : "DECLINED";
    if (act.state === target) return { action: act, alreadyProcessed: true as const };
    if (act.state !== "PENDING_ACCEPT") throw new LumiError("INVALID_TRANSITION", 409, { state: act.state });
    if (target === "ACCEPTED") {
      const [asst] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [act.pic_assistant_id]);
      const [task] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [act.task_id]);
      if (task.status === "ON_HOLD" && task.hold_reason === "MEETING_ACCEPT") {
        await t.query(`UPDATE tasks SET status='QUEUED',hold_reason=NULL,updated_at=$2 WHERE id=$1`, [task.id, iso(a.now)]);
        await createRun(t, task.id, asst, "INITIAL", a.now, { text: task.description ?? task.title, title: task.title, expected_output: task.expected_output, due: task.due_at });
      }
    } else {
      await t.query(`UPDATE tasks SET needs_decision=true,updated_at=$2 WHERE id=$1`, [act.task_id, iso(a.now)]);
      await enqueueNotify(t, `notify:meeting-decline:${act.id}`, { type: "MEETING_ACTION_DECLINED", meeting: m.code, item: a.itemKey }, a.now);
    }
    await t.query(`UPDATE lumi_meeting_actions SET state=$2,decline_reason=$3 WHERE id=$1`, [act.id, target, a.reason ?? null]);
    await audit(t, `meeting.action_${target.toLowerCase()}`, a.actorRef, { meetingId: m.id, itemKey: a.itemKey }, a.now);
    return { action: (await t.query<any>(`SELECT * FROM lumi_meeting_actions WHERE id=$1`, [act.id]))[0], alreadyProcessed: false as const };
  });
}

// ───────────────────────── closing, deadlines and limits (MTG-05, MTG-09)
export async function closeMeeting(db: Db, a: { meetingCode: string; actorRef: string; reason: string; outcome?: "NO_DECISION" | "NOT_CONCLUDED" | "ESCALATED"; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if ((a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  return db.tx((t) => closeIn(t, a.meetingCode, a.actorRef, a.reason.trim(), a.outcome ?? "NO_DECISION", a.now));
}
async function closeIn(t: Db, code: string, actor: string, reason: string, outcome: string, now: Date) {
  const [m] = await t.query<any>(`SELECT * FROM lumi_meetings WHERE code=$1 FOR UPDATE`, [code]);
  if (!m) throw new LumiError("NOT_FOUND", 404);
  if (m.state !== "OPEN") return { meeting: m, alreadyProcessed: true as const };
  await dropOpenRuns(t, m.id, now);
  await markAbsent(t, m.id);
  await t.query(`UPDATE lumi_meetings SET state='CLOSED',outcome=$2,closed_at=$3,closed_by=$4,close_reason=$5 WHERE id=$1`, [m.id, outcome, iso(now), actor, reason]);
  await enqueueNotify(t, `notify:meeting-closed:${m.id}`, { type: "MEETING_CLOSED_NO_CONCLUSION", meeting: m.code, outcome, reason }, now);
  await audit(t, "meeting.closed", actor, { meetingId: m.id, outcome, reason }, now);
  return { meeting: (await t.query<any>(`SELECT * FROM lumi_meetings WHERE id=$1`, [m.id]))[0], alreadyProcessed: false as const };
}
async function dropOpenRuns(t: Db, meetingId: string, now: Date) {
  const tasks = await t.query<any>(`SELECT task_id FROM lumi_meeting_participants WHERE meeting_id=$1 AND task_id IS NOT NULL UNION SELECT synth_task_id FROM lumi_meetings WHERE id=$1 AND synth_task_id IS NOT NULL`, [meetingId]);
  for (const k of tasks) await dropPendingRuns(t, k.task_id ?? k.synth_task_id, now, "meeting closed");
}

/** Cost of the meeting from MEASURED run costs only; runs without a measurement are counted as unknown, never as zero. */
export async function meetingCost(t: Db, meetingId: string) {
  const [r] = await t.query<any>(
    `WITH ts AS (SELECT task_id AS id FROM lumi_meeting_participants WHERE meeting_id=$1 AND task_id IS NOT NULL UNION SELECT synth_task_id FROM lumi_meetings WHERE id=$1 AND synth_task_id IS NOT NULL)
     SELECT coalesce(sum(CASE WHEN pr.state='MEASURED' THEN pr.after_usage-pr.before_usage END),0)::float AS measured,
            count(*) FILTER (WHERE r.state IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','ABANDONED','STOPPED_CAP') AND coalesce(pr.state,'NONE') <> 'MEASURED')::int AS unknown_runs, count(r.id)::int AS runs
       FROM lumi_task_runs r JOIN ts ON ts.id=r.task_id LEFT JOIN lumi_run_cost_probes pr ON pr.run_id=r.id`, [meetingId]);
  return { measured: Number(r?.measured ?? 0), unknown_runs: Number(r?.unknown_runs ?? 0), runs: Number(r?.runs ?? 0) };
}

/** Worker tick: deadlines, limits, chair fallback, and the synthesis run. Never asks for more budget: at a limit the meeting stops with "chưa kết luận". */
export async function meetingTick(db: Db, now: Date) {
  const open = await db.query<any>(`SELECT code FROM lumi_meetings WHERE state='OPEN' ORDER BY created_at LIMIT 50`);
  let acted = 0;
  for (const o of open) {
    try {
      await db.tx(async (t) => {
        const [m] = await t.query<any>(`SELECT * FROM lumi_meetings WHERE code=$1 FOR UPDATE`, [o.code]);
        if (!m || m.state !== "OPEN") return;
        const cost = await meetingCost(t, m.id);
        await t.query(`UPDATE lumi_meetings SET cost_spent=$2,cost_unknown_runs=$3,runs_used=greatest(runs_used,$4) WHERE id=$1`, [m.id, cost.runs ? cost.measured : null, cost.unknown_runs, cost.runs]);
        if (m.max_cost !== null && cost.measured >= Number(m.max_cost)) { await closeIn(t, m.code, "system:meeting", `Chạm trần chi phí ${m.max_cost} ${m.currency} (đã đo ${cost.measured.toFixed(4)}); chưa kết luận.`, "NOT_CONCLUDED", now); acted += 1; return; }
        const cov = await requiredCoverage(t, m.id);
        const allIn = cov.every((c) => c.present) && (await t.query(`SELECT 1 FROM lumi_meeting_participants WHERE meeting_id=$1 AND role IN ('CHAIR','CONTRIBUTOR','REQUIRED_EXPERT') AND state='INVITED'`, [m.id])).length === 0;
        const due = now.getTime() >= new Date(m.closes_at).getTime();
        if (!(allIn || due)) return;
        if (!m.synth_task_id) {
          if (m.runs_used >= m.max_runs) { await closeIn(t, m.code, "system:meeting", "Hết số lượt chạy cho phép của cuộc họp; chưa kết luận (không tự xin thêm).", "NOT_CONCLUDED", now); acted += 1; return; }
          const contribs = await t.query<any>(`SELECT c.id,c.late,c.round,c.stance,c.evidence,c.risks,c.estimate,c.objection,c.proposal,p.role,p.expertise,a.slug FROM lumi_meeting_contributions c JOIN lumi_meeting_participants p ON p.id=c.participant_id LEFT JOIN lumi_assistants a ON a.id=p.assistant_id WHERE c.meeting_id=$1 ORDER BY c.created_at`, [m.id]);
          if (!contribs.filter((c: any) => !c.late).length) { await closeIn(t, m.code, "system:meeting", "Hết hạn mà chưa có đóng góp nào: không có kết luận, đưa ngoại lệ lên Chủ.", "NO_DECISION", now); acted += 1; return; }
          const chairId = m.chair_assistant_id;
          const chairContributed = (await t.query(`SELECT 1 FROM lumi_meeting_contributions c JOIN lumi_meeting_participants p ON p.id=c.participant_id WHERE c.meeting_id=$1 AND p.assistant_id=$2`, [m.id, chairId])).length > 0;
          let chair = chairId;
          // chair absent at the deadline: the backup chair (plan lead) takes over ONCE, else the meeting closes with no decision and goes to the owner
          if (!chairContributed && due) {
            if (m.backup_chair_assistant_id && !m.chair_switched) { chair = m.backup_chair_assistant_id; await t.query(`UPDATE lumi_meetings SET chair_assistant_id=$2,chair_switched=true WHERE id=$1`, [m.id, chair]); await audit(t, "meeting.chair_switched", "system:meeting", { meetingId: m.id, to: chair }, now); }
            else { await closeIn(t, m.code, "system:meeting", "Chủ trì vắng và không có chủ trì dự phòng: đóng với NO_DECISION, đưa ngoại lệ lên Chủ.", "NO_DECISION", now); acted += 1; return; }
          }
          const brief = [`Tổng hợp cuộc họp ${m.code}: ${m.title}`, `Câu hỏi: ${m.question}`, `Đóng góp (mã đóng góp dùng để trỏ về nguồn gốc):`,
            ...contribs.map((c: any) => `- [${c.id}] ${c.slug ?? "Chủ"} (${c.role}${c.expertise ? `, ${c.expertise}` : ""}${c.late ? ", MUỘN" : ""}): lập trường: ${c.stance}${c.evidence ? `; bằng chứng: ${c.evidence}` : ""}${c.risks ? `; rủi ro: ${c.risks}` : ""}${c.estimate ? `; ước tính: ${c.estimate}` : ""}${c.objection ? `; phản đối: ${c.objection}` : ""}${c.proposal ? `; đề xuất: ${c.proposal}` : ""}`),
            cov.some((c) => !c.satisfied) ? `THIẾU ý kiến chuyên môn bắt buộc: ${cov.filter((c) => !c.satisfied).map((c) => c.expertise).join(", ")}. Quyết định phụ thuộc chuyên môn đó KHÔNG được chốt; ghi rõ.` : "",
            `CÁCH LÀM: gọi meeting_synthesize(run_id, summary, lines[{text, contribution_ids[]}], conclusions[{type, text, depends_on_expertise?, payload?}]) ĐÚNG MỘT LẦN. Mỗi dòng phải trỏ về đóng góp gốc. type: RECORD, ACTION_ITEM, REASSIGN_TASK, BUDGET_CHANGE, GRANT_REQUEST, SCOPE_CHANGE, EXTERNAL_COMMITMENT, KNOWLEDGE. Hệ thống tự phân loại; bạn không tự quyết định loại. Im lặng không phải đồng ý.`].filter(Boolean).join("\n");
          const [plan] = m.plan_id ? await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1`, [m.plan_id]) : [];
          const tk = (await createTaskInTx(t, {
            actorRef: "system:meeting", clientRequestId: `meeting-${m.id}-synth`, projectId: m.project_id, assigneeId: chair, title: `Họp ${m.code}: tổng hợp biên bản`, description: brief, expectedOutput: "Một biên bản gửi bằng công cụ meeting_synthesize", now,
            ...(plan ? { plan: { planId: plan.id, planVersion: null, planTaskKey: null, acceptance: null, sourceKey: `meeting:${m.id}:synth`, source: "MEETING" } } : {}),
          })).task;
          await t.query(`UPDATE lumi_meetings SET synth_task_id=$2,runs_used=runs_used+1 WHERE id=$1`, [m.id, tk.id]);
          acted += 1; return;
        }
        // the synthesis run was sent but nothing arrived within a day after the deadline: stop, never loop
        if (now.getTime() > new Date(m.closes_at).getTime() + 86400_000) { await closeIn(t, m.code, "system:meeting", "Chủ trì không nộp biên bản sau hạn: đóng với NO_DECISION, đưa ngoại lệ lên Chủ.", "NO_DECISION", now); acted += 1; }
      });
    } catch { /* one meeting failing never blocks the others */ }
  }
  return { acted };
}

// ───────────────────────── read side
export async function listMeetings(db: Db) {
  return db.query<any>(
    `SELECT m.id,m.code,m.title,m.reason,m.state,m.outcome,m.opens_at,m.closes_at,m.runs_used,m.max_runs,m.max_rounds,m.max_cost,m.currency,m.cost_spent,m.cost_unknown_runs,a.name AS chair_name,p.code AS plan_code,
            (SELECT count(*)::int FROM lumi_meeting_contributions c WHERE c.meeting_id=m.id) AS contributions,
            (SELECT count(*)::int FROM lumi_meeting_conclusions c WHERE c.meeting_id=m.id AND c.state='PENDING_OWNER') AS pending_owner
       FROM lumi_meetings m JOIN lumi_assistants a ON a.id=m.chair_assistant_id LEFT JOIN lumi_plans p ON p.id=m.plan_id ORDER BY m.created_at DESC LIMIT 100`);
}
export async function getMeeting(db: Db, code: string) {
  const [m] = await db.query<any>(`SELECT m.*,a.name AS chair_name,p.code AS plan_code FROM lumi_meetings m JOIN lumi_assistants a ON a.id=m.chair_assistant_id LEFT JOIN lumi_plans p ON p.id=m.plan_id WHERE m.code=$1`, [code]);
  if (!m) throw new LumiError("NOT_FOUND", 404);
  const participants = await db.query<any>(`SELECT p.id,p.role,p.expertise,p.state,p.task_id,a.name,a.slug,(SELECT code FROM tasks WHERE id=p.task_id) AS task_code FROM lumi_meeting_participants p LEFT JOIN lumi_assistants a ON a.id=p.assistant_id WHERE p.meeting_id=$1 ORDER BY p.role,a.name`, [m.id]);
  const contributions = await db.query<any>(`SELECT c.*,coalesce(a.name,'Chủ') AS who,p.role FROM lumi_meeting_contributions c JOIN lumi_meeting_participants p ON p.id=c.participant_id LEFT JOIN lumi_assistants a ON a.id=p.assistant_id WHERE c.meeting_id=$1 ORDER BY c.created_at`, [m.id]);
  const notes = await db.query<any>(`SELECT version,summary,lines,self_checked,created_by,created_at FROM lumi_meeting_notes WHERE meeting_id=$1 ORDER BY version DESC`, [m.id]);
  const conclusions = await db.query<any>(`SELECT * FROM lumi_meeting_conclusions WHERE meeting_id=$1 ORDER BY note_version DESC, idx`, [m.id]);
  const actions = await db.query<any>(`SELECT x.*,a.name AS pic_name,(SELECT code FROM tasks WHERE id=x.task_id) AS task_code FROM lumi_meeting_actions x JOIN lumi_assistants a ON a.id=x.pic_assistant_id WHERE x.meeting_id=$1 ORDER BY x.created_at`, [m.id]);
  const coverage = await requiredCoverage(db, m.id);
  const cost = await meetingCost(db, m.id);
  return { meeting: m, participants, contributions, notes, conclusions, actions, coverage, cost };
}
export async function pendingMeetingProposals(db: Db) {
  return db.query<any>(`SELECT c.id,c.type,c.text,c.reason,c.created_at,m.code AS meeting_code,m.title AS meeting_title FROM lumi_meeting_conclusions c JOIN lumi_meetings m ON m.id=c.meeting_id WHERE c.state='PENDING_OWNER' ORDER BY c.created_at`);
}
