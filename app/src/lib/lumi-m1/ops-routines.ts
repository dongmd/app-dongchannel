/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 6 — Routine (RTN-01..05, EXE-02). Two kinds only: NOTIFY (no model call, no AI cost) and CREATE_TASK (one coded task per run, inside the normal task lifecycle, so cost limits,
 * run caps and "never self-approve" all apply unchanged). A routine is created OFF; turning it on is an owner action and is refused while a limit is missing (EXE-02).
 * One record per (routine, scheduled slot) — the same slot can never run twice. Missed slots run once within the catch-up window, otherwise are recorded as skipped.
 */
import { LumiError, audit, enqueueNotify, missingExecConfig, requireRole, type Db } from "./core";
import { createTaskInTx } from "./core-web";
import { getSettingNumber } from "./ops-tools";

const iso = (d: Date) => d.toISOString();
export const TIMEZONES = ["Asia/Ho_Chi_Minh", "Asia/Bangkok", "Asia/Tokyo", "UTC", "Europe/London", "America/New_York"] as const;
export const SCHEDULES = ["DAILY", "WEEKDAYS", "WEEKLY"] as const;
export const KINDS = ["NOTIFY", "CREATE_TASK"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAYS = ["", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ nhật"];

/** offset (ms) of `tz` from UTC at instant `d` */
function tzOffset(d: Date, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(d)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(d.getTime() / 1000) * 1000;
}
/** local wall-clock time in `tz` → UTC instant (handles zones with DST by re-checking the offset) */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mi);
  let t = guess - tzOffset(new Date(guess), tz);
  t = guess - tzOffset(new Date(t), tz);
  return new Date(t);
}
function localParts(d: Date, tz: string) {
  const o = new Date(d.getTime() + tzOffset(d, tz));
  return { y: o.getUTCFullYear(), m: o.getUTCMonth() + 1, d: o.getUTCDate(), wd: o.getUTCDay() === 0 ? 7 : o.getUTCDay() };
}
export const localDay = (d: Date, tz: string) => { const p = localParts(d, tz); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };

/** first scheduled slot strictly after `after` */
export function nextSlot(r: { schedule_kind: string; time_of_day: string; weekday: number | null; timezone: string }, after: Date): Date {
  const [hh, mi] = r.time_of_day.split(":").map(Number) as [number, number];
  const base = localParts(after, r.timezone);
  for (let i = 0; i < 9; i++) {
    const day = new Date(Date.UTC(base.y, base.m - 1, base.d + i));
    const wd = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (r.schedule_kind === "WEEKDAYS" && wd > 5) continue;
    if (r.schedule_kind === "WEEKLY" && wd !== r.weekday) continue;
    const slot = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mi, r.timezone);
    if (slot.getTime() > after.getTime()) return slot;
  }
  throw new LumiError("VALIDATION_ERROR", 400, { missing: ["schedule"] });
}
export function scheduleText(r: { schedule_kind: string; time_of_day: string; weekday: number | null; timezone: string }): string {
  const when = r.schedule_kind === "DAILY" ? "Hằng ngày" : r.schedule_kind === "WEEKDAYS" ? "Thứ 2–6" : `${DAYS[r.weekday ?? 1]} hằng tuần`;
  return `${when}, ${r.time_of_day} (${r.timezone})`;
}

export interface RoutineInput {
  actorRef: string; name: string; kind: string; scheduleKind: string; timeOfDay: string; weekday?: number | null; timezone?: string;
  projectId?: string; assigneeId?: string; templateId?: string; title?: string; description?: string; message?: string; maxRunsPerDay?: number; deadlineMinutes?: number; now: Date;
}
function validate(i: Partial<RoutineInput>, full: boolean) {
  const bad: string[] = [];
  if (full || i.name !== undefined) if (typeof i.name !== "string" || i.name.trim().length < 3 || i.name.length > 120) bad.push("name(3..120)");
  if (full || i.kind !== undefined) if (!(KINDS as readonly string[]).includes(i.kind as string)) bad.push("kind(NOTIFY|CREATE_TASK)");
  if (full || i.scheduleKind !== undefined) if (!(SCHEDULES as readonly string[]).includes(i.scheduleKind as string)) bad.push("schedule_kind(DAILY|WEEKDAYS|WEEKLY)");
  if (full || i.timeOfDay !== undefined) if (typeof i.timeOfDay !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(i.timeOfDay)) bad.push("time_of_day(HH:MM)");
  if (i.scheduleKind === "WEEKLY" && !(Number.isInteger(i.weekday) && i.weekday! >= 1 && i.weekday! <= 7)) bad.push("weekday(1..7)");
  if (i.timezone !== undefined && !(TIMEZONES as readonly string[]).includes(i.timezone)) bad.push(`timezone(${TIMEZONES.join("|")})`);
  if (i.maxRunsPerDay !== undefined && !(Number.isInteger(i.maxRunsPerDay) && i.maxRunsPerDay >= 1 && i.maxRunsPerDay <= 100)) bad.push("max_runs_per_day(1..100)");
  if (i.deadlineMinutes !== undefined && !(Number.isInteger(i.deadlineMinutes) && i.deadlineMinutes >= 1 && i.deadlineMinutes <= 10080)) bad.push("deadline_minutes(1..10080)");
  if (i.message !== undefined && (i.message.trim().length < 3 || i.message.length > 1000)) bad.push("message(3..1000)");
  for (const [k, v] of [["project_id", i.projectId], ["assignee_id", i.assigneeId], ["template_id", i.templateId]] as const) if (v !== undefined && !UUID.test(v)) bad.push(`${k}(uuid)`);
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
}

export async function createRoutine(db: Db, i: RoutineInput) {
  await requireRole(db, i.actorRef, ["OWNER", "ADMIN"]);
  validate(i, true);
  if (i.kind === "NOTIFY" && !i.message) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["message"] });
  if (i.kind === "CREATE_TASK" && !i.templateId && !i.title) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["title hoặc template_id"] });
  const [r] = await db.query<any>(
    `INSERT INTO lumi_routines(name,kind,schedule_kind,time_of_day,weekday,timezone,project_id,assignee_id,template_id,title,description,message,max_runs_per_day,deadline_minutes,created_by,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *`,
    [i.name.trim(), i.kind, i.scheduleKind, i.timeOfDay, i.scheduleKind === "WEEKLY" ? i.weekday : null, i.timezone ?? "Asia/Ho_Chi_Minh", i.projectId ?? null, i.assigneeId ?? null, i.templateId ?? null, i.title ?? null, i.description ?? null, i.message ?? null, i.maxRunsPerDay ?? null, i.deadlineMinutes ?? null, i.actorRef, iso(i.now)]);
  await audit(db, "routine.create", i.actorRef, { code: r.code }, i.now);
  return { routine: r };
}

/** EXE-02: what is missing before a routine may be switched on */
export async function missingLimits(db: Db, r: any): Promise<string[]> {
  const miss: string[] = [];
  if (!r.max_runs_per_day) miss.push("max_runs_per_day");
  if (r.kind === "NOTIFY") return miss;
  if (!r.deadline_minutes) miss.push("deadline_minutes");
  if (!r.project_id) miss.push("project_id");
  if (!r.assignee_id) { miss.push("assignee_id"); return miss; }
  const [a] = await db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [r.assignee_id]);
  if (!a) { miss.push("assignee_id(không còn hoạt động)"); return miss; }
  for (const m of missingExecConfig(a)) miss.push(`assignee.${m}`);
  if (a.connection_state !== "VERIFIED") miss.push("assignee.connection(chưa kiểm tra thật)");
  if (!a.dispatch_enabled) miss.push("assignee.dispatch(giao việc đang tắt)");
  return miss;
}

export async function updateRoutine(db: Db, i: Partial<RoutineInput> & { actorRef: string; routineId: string; now: Date }) {
  await requireRole(db, i.actorRef, ["OWNER", "ADMIN"]);
  validate(i, false);
  return db.tx(async (t) => {
    const [r] = await t.query<any>(`SELECT * FROM lumi_routines WHERE id=$1 FOR UPDATE`, [i.routineId]);
    if (!r) throw new LumiError("NOT_FOUND", 404);
    const n = {
      name: i.name?.trim() ?? r.name, schedule_kind: i.scheduleKind ?? r.schedule_kind, time_of_day: i.timeOfDay ?? r.time_of_day, timezone: i.timezone ?? r.timezone,
      weekday: (i.scheduleKind ?? r.schedule_kind) === "WEEKLY" ? (i.weekday ?? r.weekday) : null, title: i.title ?? r.title, description: i.description ?? r.description, message: i.message ?? r.message,
      max_runs_per_day: i.maxRunsPerDay ?? r.max_runs_per_day, deadline_minutes: i.deadlineMinutes ?? r.deadline_minutes, assignee_id: i.assigneeId ?? r.assignee_id, project_id: i.projectId ?? r.project_id,
    };
    if (n.schedule_kind === "WEEKLY" && !n.weekday) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["weekday(1..7)"] });
    if (r.enabled) { const miss = await missingLimits(t, { ...r, ...n }); if (miss.length) throw new LumiError("VALIDATION_ERROR", 400, { missing: miss, rule: "EXE-02" }); }
    const next = r.enabled ? nextSlot(n as any, i.now) : r.next_run_at ? nextSlot(n as any, i.now) : null; // đổi múi giờ/giờ ⇒ tính lại lần chạy kế tiếp
    const [u] = await t.query<any>(
      `UPDATE lumi_routines SET name=$2,schedule_kind=$3,time_of_day=$4,weekday=$5,timezone=$6,title=$7,description=$8,message=$9,max_runs_per_day=$10,deadline_minutes=$11,assignee_id=$12,project_id=$13,next_run_at=$14,updated_at=$15 WHERE id=$1 RETURNING *`,
      [r.id, n.name, n.schedule_kind, n.time_of_day, n.weekday, n.timezone, n.title, n.description, n.message, n.max_runs_per_day, n.deadline_minutes, n.assignee_id, n.project_id, next ? iso(next) : null, iso(i.now)]);
    await audit(t, "routine.update", i.actorRef, { code: r.code }, i.now);
    return { routine: u };
  });
}

export async function setRoutineEnabled(db: Db, a: { actorRef: string; routineId: string; enabled: boolean; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]); // a routine spends AI cost on a schedule: switching it on is the owner's decision
  return db.tx(async (t) => {
    const [r] = await t.query<any>(`SELECT * FROM lumi_routines WHERE id=$1 FOR UPDATE`, [a.routineId]);
    if (!r) throw new LumiError("NOT_FOUND", 404);
    if (a.enabled) {
      const miss = await missingLimits(t, r);
      if (miss.length) throw new LumiError("VALIDATION_ERROR", 400, { missing: miss, rule: "EXE-02" });
    }
    const [u] = await t.query<any>(
      `UPDATE lumi_routines SET enabled=$2,next_run_at=$3,consecutive_failures=CASE WHEN $2 THEN 0 ELSE consecutive_failures END,alerted=CASE WHEN $2 THEN false ELSE alerted END,last_error=CASE WHEN $2 THEN NULL ELSE last_error END,updated_at=$4 WHERE id=$1 RETURNING *`,
      [r.id, a.enabled, a.enabled ? iso(nextSlot(r, a.now)) : null, iso(a.now)]);
    await audit(t, a.enabled ? "routine.enable" : "routine.disable", a.actorRef, { code: r.code }, a.now);
    return { routine: u };
  });
}

export async function setRoutinesPaused(db: Db, a: { actorRef: string; paused: boolean; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('routines_paused',$1::jsonb,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,set_by=EXCLUDED.set_by,set_at=EXCLUDED.set_at`, [JSON.stringify(a.paused), a.actorRef, iso(a.now)]);
  await audit(db, "routine.pause_all", a.actorRef, { paused: a.paused }, a.now);
  return { paused: a.paused };
}
export async function routinesPaused(db: Db): Promise<boolean> {
  const [f] = await db.query<any>(`SELECT value FROM lumi_system_flags WHERE key='routines_paused'`);
  return f ? f.value === true || f.value === "true" : false;
}

const fillTitle = (s: string, slot: Date, tz: string) => s.replace(/\{date\}/g, localDay(slot, tz));

/** Executes ONE slot. Never throws for business refusals: the outcome (and the failure counter) is recorded; the same slot cannot be recorded twice. */
export async function runSlot(db: Db, routineId: string, slot: Date, trigger: "SCHEDULE" | "CATCHUP" | "MANUAL", now: Date): Promise<{ result: string; taskCode?: string; duplicate?: boolean }> {
  const [r0] = await db.query<any>(`SELECT * FROM lumi_routines WHERE id=$1`, [routineId]);
  if (!r0) throw new LumiError("NOT_FOUND", 404);
  const record = async (t: Db, result: string, taskId: string | null, error: string | null) => {
    const ins = await t.query<any>(`INSERT INTO lumi_routine_runs(routine_id,scheduled_for,trigger,result,task_id,error,started_at,finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (routine_id,scheduled_for) DO NOTHING RETURNING id`, [routineId, iso(slot), trigger, result, taskId, error, iso(now)]);
    return ins.length > 0;
  };
  const finish = async (result: string, taskId: string | null, error: string | null) => {
    return db.tx(async (t) => {
      await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`routine:${routineId}`]);
      if (!(await record(t, result, taskId, error))) return false;
      const bad = result === "FAILED" || result === "CAP";
      const [r] = await t.query<any>(`UPDATE lumi_routines SET consecutive_failures=CASE WHEN $2 THEN consecutive_failures+1 WHEN $3 THEN 0 ELSE consecutive_failures END,last_error=CASE WHEN $2 THEN $4 ELSE last_error END,updated_at=$5 WHERE id=$1 RETURNING *`, [routineId, bad, result === "DONE", error, iso(now)]);
      const threshold = await getSettingNumber(t, "routine_fail_threshold");
      if (bad && r.consecutive_failures >= threshold && !r.alerted) { // RTN-04: exactly one alert at the crossing; the routine stops (never retries forever)
        await t.query(`UPDATE lumi_routines SET alerted=true,enabled=false,next_run_at=NULL WHERE id=$1`, [routineId]);
        await enqueueNotify(t, `notify:routine-fail:${routineId}:${r.consecutive_failures}`, { type: "ROUTINE_FAILING", routine: r.code, failures: r.consecutive_failures, last_error: error }, now);
      }
      return true;
    });
  };
  const dup = (): { result: string; duplicate: true } => ({ result: "DUPLICATE", duplicate: true });
  // already recorded for this slot?
  const [seen] = await db.query<any>(`SELECT result FROM lumi_routine_runs WHERE routine_id=$1 AND scheduled_for=$2`, [routineId, iso(slot)]);
  if (seen) return dup();
  if (r0.kind === "CREATE_TASK" && (await routinesPaused(db))) return (await finish("STOPPED", null, "Đã tạm dừng tất cả routine")) ? { result: "STOPPED" } : dup();
  const day = localDay(slot, r0.timezone);
  const sameDay = (await db.query<any>(`SELECT scheduled_for FROM lumi_routine_runs WHERE routine_id=$1 AND result='DONE' AND scheduled_for >= $2::timestamptz - interval '1 day' AND scheduled_for <= $2::timestamptz + interval '1 day'`, [routineId, iso(slot)])).filter((x: any) => localDay(new Date(x.scheduled_for), r0.timezone) === day).length;
  if (r0.max_runs_per_day && sameDay >= r0.max_runs_per_day) return (await finish("CAP", null, `Đã đủ ${r0.max_runs_per_day} lần chạy trong ngày`)) ? { result: "CAP" } : dup();
  if (r0.kind === "NOTIFY") {
    await enqueueNotify(db, `notify:routine:${routineId}:${iso(slot)}`, { type: "ROUTINE_NOTICE", routine: r0.code, message: r0.message }, now);
    return (await finish("DONE", null, null)) ? { result: "DONE" } : dup();
  }
  // CREATE_TASK: one coded task, created under the routine's creator, through the normal lifecycle
  try {
    const out = await db.tx(async (t) => {
      await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`routine:${routineId}`]);
      const [again] = await t.query<any>(`SELECT 1 FROM lumi_routine_runs WHERE routine_id=$1 AND scheduled_for=$2`, [routineId, iso(slot)]);
      if (again) return null;
      let title = r0.title as string | null; let description = r0.description as string | null; let tplVersion: number | null = null; let expected: string | undefined;
      if (r0.template_id) {
        const [tp] = await t.query<any>(`SELECT v.*, t.approved_version FROM lumi_task_templates t JOIN lumi_task_template_versions v ON v.template_id=t.id AND v.version=t.approved_version WHERE t.id=$1 AND t.state='ACTIVE'`, [r0.template_id]);
        if (!tp) throw new LumiError("NOT_FOUND", 404, { what: "template đã duyệt" });
        tplVersion = tp.approved_version; title = title ?? tp.default_title; description = [r0.description, tp.description, `Các bước:\n${tp.steps}`, `Đầu vào: ${tp.inputs}`].filter(Boolean).join("\n\n"); expected = tp.outputs;
      }
      const due = r0.deadline_minutes ? new Date(now.getTime() + r0.deadline_minutes * 60_000).toISOString() : undefined;
      const res = await createTaskInTx(t, { actorRef: r0.created_by, clientRequestId: `rtn-${r0.id}-${slot.getTime()}`, projectId: r0.project_id, assigneeId: r0.assignee_id, title: fillTitle(title ?? "", slot, r0.timezone), description: description ? fillTitle(description, slot, r0.timezone) : undefined, due, expectedOutput: expected, now } as any);
      if (r0.template_id && tplVersion) await t.query(`INSERT INTO lumi_task_template_uses(task_id,template_id,version,used_by,used_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [res.task.id, r0.template_id, tplVersion, `routine:${r0.code}`, iso(now)]);
      await record(t, "DONE", res.task.id, null);
      await t.query(`UPDATE lumi_routines SET consecutive_failures=0,alerted=false,updated_at=$2 WHERE id=$1`, [routineId, iso(now)]);
      return res.task;
    });
    return out ? { result: "DONE", taskCode: out.code } : dup();
  } catch (e) {
    if (!(e instanceof LumiError)) throw e;
    const cap = e.code === "COST_CAP" || e.code === "RETRY_LIMIT";
    return (await finish(cap ? "CAP" : "FAILED", null, `${e.code}${Object.keys(e.data).length ? " " + JSON.stringify(e.data).slice(0, 300) : ""}`)) ? { result: cap ? "CAP" : "FAILED" } : dup();
  }
}

export async function runRoutineNow(db: Db, a: { actorRef: string; routineId: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const [r] = await db.query<any>(`SELECT * FROM lumi_routines WHERE id=$1`, [a.routineId]);
  if (!r) throw new LumiError("NOT_FOUND", 404);
  const miss = await missingLimits(db, r);
  if (miss.length) throw new LumiError("VALIDATION_ERROR", 400, { missing: miss, rule: "EXE-02" });
  return runSlot(db, a.routineId, a.now, "MANUAL", a.now);
}

/** Worker tick: every enabled routine whose slot is due. A missed slot runs ONCE inside the catch-up window; older ones are recorded as skipped. */
export async function routineTick(db: Db, now: Date): Promise<{ ran: number; skipped: number }> {
  const catchup = (await getSettingNumber(db, "routine_catchup_hours")) * 3600_000;
  const due = await db.query<any>(`SELECT id FROM lumi_routines WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at`, [iso(now)]);
  let ran = 0, skipped = 0;
  for (const d of due) {
    const [r] = await db.query<any>(`SELECT * FROM lumi_routines WHERE id=$1 AND enabled AND next_run_at <= $2`, [d.id, iso(now)]);
    if (!r) continue;
    const slot = new Date(r.next_run_at); const late = now.getTime() - slot.getTime();
    // advance first (compare-and-set) so two workers never run the same slot; the unique (routine, slot) record is the final guard
    const adv = await db.query<any>(`UPDATE lumi_routines SET next_run_at=$3 WHERE id=$1 AND next_run_at=$2 RETURNING id`, [r.id, iso(slot), iso(nextSlot(r, now))]);
    if (!adv.length) continue;
    if (late > catchup) {
      await db.query(`INSERT INTO lumi_routine_runs(routine_id,scheduled_for,trigger,result,error,started_at,finished_at) VALUES ($1,$2,'CATCHUP','SKIPPED',$3,$4,$4) ON CONFLICT DO NOTHING`, [r.id, iso(slot), `Lỡ mốc quá cửa sổ chạy bù (${Math.round(late / 3600_000)} giờ)`, iso(now)]);
      skipped++; continue;
    }
    await runSlot(db, r.id, slot, late > 5 * 60_000 ? "CATCHUP" : "SCHEDULE", now); ran++;
  }
  return { ran, skipped };
}

export async function listRoutines(db: Db, now: Date) {
  const rows = await db.query<any>(
    `SELECT r.*, p.name AS project_name, a.name AS assignee_name, tp.code AS template_code FROM lumi_routines r LEFT JOIN lumi_projects p ON p.id=r.project_id LEFT JOIN lumi_assistants a ON a.id=r.assignee_id LEFT JOIN lumi_task_templates tp ON tp.id=r.template_id ORDER BY r.created_at`);
  const runs = await db.query<any>(
    `SELECT x.* FROM (SELECT ru.*, tk.code AS task_code, row_number() OVER (PARTITION BY ru.routine_id ORDER BY ru.scheduled_for DESC) rn FROM lumi_routine_runs ru LEFT JOIN tasks tk ON tk.id=ru.task_id) x WHERE x.rn <= 10 ORDER BY x.scheduled_for DESC`);
  return {
    paused: await routinesPaused(db),
    routines: rows.map((r: any) => ({ ...r, schedule_text: scheduleText(r), runs: runs.filter((x: any) => x.routine_id === r.id) })),
    system: ["aff", "yt"].map((s) => ({ name: `ops-hub-alerts (${s})`, kind: "NOTIFY", schedule_text: "Mỗi 5 phút", read_only: true, last_run: null, note: "Job chạy ngoài ứng dụng (Ops Hub); ứng dụng chưa có số liệu lần chạy gần nhất nên không hiển thị" })),
    now: iso(now),
  };
}
