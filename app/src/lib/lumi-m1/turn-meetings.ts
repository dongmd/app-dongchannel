/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 8 (nhóm 3) — MTG-04 turn-based meeting. The app runs ONE turn at a time (a task/run for the next speaker, in the order the owner chose); each turn sees the previous turns.
 * It stops, in this order, on: deadline, MEASURED cost cap, a full round that all agree (CONCLUDED), max turns, or a full round with no new position. It never decides anything:
 * a conclusion is only a recorded outcome for the owner; "chưa kết luận" is a normal result. Two bots can never push back and forth forever (turn cap + no-new-position rule).
 * Real bots can take turns only through the MCP tool `meeting_turn_submit`; cost is whatever the real runs cost (measured), booked as coordination.
 */
import { LumiError, audit, enqueueNotify, requireRole, type Db } from "./core";
import { createTaskInTx } from "./core-web";

const iso = (d: Date) => d.toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DAYS = 14;

async function brief(t: Db, m: any, turnNo: number): Promise<string> {
  const prev = await t.query<any>(`SELECT e.turn_no,e.stance,e.new_position,e.agrees,a.name FROM lumi_turn_entries e JOIN lumi_assistants a ON a.id=e.assistant_id WHERE e.meeting_id=$1 AND e.state='DONE' ORDER BY e.turn_no`, [m.id]);
  return [`Họp theo lượt ${m.code} — lượt ${turnNo}/${m.max_turns}. Câu hỏi: ${m.question}`,
    prev.length ? `Các lượt trước:\n${prev.map((p: any) => `#${p.turn_no} ${p.name}${p.agrees ? " (đồng ý)" : ""}: ${p.stance}`).join("\n")}` : "Bạn là người phát biểu đầu tiên.",
    "Nộp bằng công cụ meeting_turn_submit: stance (lập trường, 3–4000 ký tự), new_position (true nếu có lập trường/lập luận MỚI so với các lượt trước), agrees (true nếu bạn đồng ý với phương án hiện tại). Không có chat tự do. Không tự ra quyết định thay Chủ."].join("\n\n");
}
async function createTurn(t: Db, m: any, turnNo: number, now: Date) {
  const assistantId = m.speakers[(turnNo - 1) % m.speakers.length];
  const [e] = await t.query<any>(`INSERT INTO lumi_turn_entries(meeting_id,turn_no,assistant_id,created_at) VALUES ($1,$2,$3,$4) RETURNING id`, [m.id, turnNo, assistantId, iso(now)]);
  const task = (await createTaskInTx(t, { actorRef: "system:turn-meeting", clientRequestId: `turn-${m.id}-${turnNo}`, projectId: m.project_id, assigneeId: assistantId, title: `Họp ${m.code}: lượt ${turnNo}`, description: await brief(t, m, turnNo), expectedOutput: "Một lượt phát biểu có cấu trúc gửi bằng meeting_turn_submit", now } as any)).task;
  await t.query(`UPDATE lumi_turn_entries SET task_id=$2 WHERE id=$1`, [e.id, task.id]);
  return task;
}
export async function turnMeetingCost(t: Db, meetingId: string): Promise<{ measured: number; unknown_runs: number }> {
  const [r] = await t.query<any>(
    `SELECT coalesce(sum(CASE WHEN pr.state='MEASURED' THEN pr.after_usage-pr.before_usage END),0)::float AS measured,
            count(r.id) FILTER (WHERE r.state IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED') AND (pr.run_id IS NULL OR pr.state<>'MEASURED'))::int AS unknown_runs
       FROM lumi_turn_entries e JOIN lumi_task_runs r ON r.task_id=e.task_id LEFT JOIN lumi_run_cost_probes pr ON pr.run_id=r.id WHERE e.meeting_id=$1`, [meetingId]);
  return { measured: Number(r?.measured ?? 0), unknown_runs: Number(r?.unknown_runs ?? 0) };
}

export async function openTurnMeeting(db: Db, a: { actorRef: string; title: string; question: string; projectId: string; speakerIds: string[]; maxTurns: number; maxCost?: number; closesAt: Date; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]); // each turn is a paid model run: the owner opens turn meetings
  const bad: string[] = [];
  if (typeof a.title !== "string" || a.title.trim().length < 3 || a.title.length > 200) bad.push("title(3..200)");
  if (typeof a.question !== "string" || a.question.trim().length < 3 || a.question.length > 4000) bad.push("question(3..4000)");
  if (!UUID.test(a.projectId ?? "")) bad.push("project_id(uuid)");
  if (!Array.isArray(a.speakerIds) || a.speakerIds.length < 2 || a.speakerIds.length > 6 || new Set(a.speakerIds).size !== a.speakerIds.length || a.speakerIds.some((x) => !UUID.test(x))) bad.push("speaker_ids(2..6 bot khác nhau, theo thứ tự phát biểu)");
  if (!Number.isInteger(a.maxTurns) || a.maxTurns < 2 || a.maxTurns > 30) bad.push("max_turns(2..30)");
  else if (Array.isArray(a.speakerIds) && a.maxTurns < a.speakerIds.length) bad.push("max_turns(≥ số người phát biểu)");
  if (a.maxCost === undefined || !(a.maxCost >= 0)) bad.push("max_cost(bắt buộc, ≥0; trần chi phí ĐO THẬT)");
  if (!(a.closesAt instanceof Date) || Number.isNaN(a.closesAt.getTime()) || a.closesAt.getTime() <= a.now.getTime() || a.closesAt.getTime() > a.now.getTime() + MAX_DAYS * 86400_000) bad.push(`closes_at(sau bây giờ, tối đa ${MAX_DAYS} ngày)`);
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    const [p] = await t.query<any>(`SELECT id FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [a.projectId]);
    if (!p) throw new LumiError("NOT_FOUND", 404, { what: "project" });
    const bots = await t.query<any>(`SELECT a.id FROM lumi_assistants a JOIN lumi_project_members m ON m.assistant_id=a.id AND m.project_id=$2 WHERE a.id = ANY($1::uuid[]) AND a.status='ACTIVE' AND a.connection_state='VERIFIED' AND a.dispatch_enabled`, [a.speakerIds, a.projectId]);
    if (bots.length !== a.speakerIds.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["speaker_ids(mọi bot phải đang hoạt động, đã kiểm tra kết nối thật, bật giao việc và thuộc dự án)"] });
    const [m] = await t.query<any>(`INSERT INTO lumi_turn_meetings(title,question,project_id,speakers,max_turns,max_cost,closes_at,created_by,created_at) VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9) RETURNING *`, [a.title.trim(), a.question.trim(), a.projectId, a.speakerIds, a.maxTurns, a.maxCost, iso(a.closesAt), a.actorRef, iso(a.now)]);
    await createTurn(t, m, 1, a.now);
    await audit(t, "turn_meeting.opened", a.actorRef, { code: m.code, speakers: a.speakerIds.length, maxTurns: a.maxTurns }, a.now);
    return { meeting: m };
  });
}

async function closeIn(t: Db, m: any, outcome: "CONCLUDED" | "NOT_CONCLUDED", reason: string, now: Date, by: string) {
  const done = await t.query<any>(`SELECT e.turn_no,e.stance,e.agrees,a.name FROM lumi_turn_entries e JOIN lumi_assistants a ON a.id=e.assistant_id WHERE e.meeting_id=$1 AND e.state='DONE' ORDER BY e.turn_no DESC LIMIT ${m.speakers.length}`, [m.id]);
  const summary = done.reverse().map((d: any) => `#${d.turn_no} ${d.name}${d.agrees ? " (đồng ý)" : ""}: ${String(d.stance).slice(0, 300)}`).join("\n") || "Chưa có lượt nào hoàn tất.";
  await t.query(`UPDATE lumi_turn_entries SET state='SKIPPED' WHERE meeting_id=$1 AND state='PENDING'`, [m.id]);
  await t.query(`UPDATE lumi_task_runs SET state='CANCELLED' WHERE state='PENDING' AND task_id IN (SELECT task_id FROM lumi_turn_entries WHERE meeting_id=$1 AND state='SKIPPED')`, [m.id]);
  await t.query(`UPDATE lumi_turn_meetings SET state='CLOSED',outcome=$2,stop_reason=$3,summary=$4,closed_at=$5 WHERE id=$1`, [m.id, outcome, reason, summary, iso(now)]);
  await enqueueNotify(t, `notify:turn-meeting:${m.id}`, { type: "TURN_MEETING_CLOSED", code: m.code, outcome, reason }, now);
  await audit(t, "turn_meeting.closed", by, { code: m.code, outcome, reason }, now);
}
const STOP_NOTE: Record<string, string> = { AGREED: "Một vòng đầy đủ đều đồng ý", MAX_TURNS: "Chạm số lượt tối đa", COST: "Chạm trần chi phí đo thật", TIME: "Quá hạn giờ", NO_NEW_POSITION: "Một vòng không có lập trường mới", MANUAL: "Chủ đóng họp" };
export { STOP_NOTE };

/** one bot's turn. Idempotent; after it, the next turn is opened or the meeting is closed with the reason */
export async function submitTurn(db: Db, a: { taskId: string; actorRef: string; assistantId: string; stance: string; newPosition: boolean; agrees: boolean; now: Date }) {
  if (typeof a.stance !== "string" || a.stance.trim().length < 3 || a.stance.length > 4000) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["stance(3..4000)"] });
  if (typeof a.newPosition !== "boolean" || typeof a.agrees !== "boolean") throw new LumiError("VALIDATION_ERROR", 400, { errors: ["new_position(boolean)", "agrees(boolean)"] });
  return db.tx(async (t) => {
    const [e] = await t.query<any>(`SELECT * FROM lumi_turn_entries WHERE task_id=$1 FOR UPDATE`, [a.taskId]);
    if (!e || e.assistant_id !== a.assistantId) throw new LumiError("NOT_FOUND", 404, { what: "lượt phát biểu của bạn" });
    const [m] = await t.query<any>(`SELECT * FROM lumi_turn_meetings WHERE id=$1 FOR UPDATE`, [e.meeting_id]);
    if (e.state === "DONE") return { alreadyProcessed: true as const, meeting: m, status: "DONE" };
    if (m.state === "CLOSED" || e.state === "SKIPPED") return { alreadyProcessed: false as const, late: true as const, meeting: m, status: "LATE" };
    await t.query(`UPDATE lumi_turn_entries SET state='DONE',stance=$2,new_position=$3,agrees=$4,done_at=$5 WHERE id=$1`, [e.id, a.stance.trim(), a.newPosition, a.agrees, iso(a.now)]);
    const n = m.speakers.length; const turnNo = e.turn_no;
    const round = turnNo >= n ? await t.query<any>(`SELECT new_position,agrees FROM lumi_turn_entries WHERE meeting_id=$1 AND state='DONE' AND turn_no > $2 ORDER BY turn_no`, [m.id, turnNo - n]) : [];
    const fullRound = round.length === n;
    const cost = await turnMeetingCost(t, m.id);
    let stop: { outcome: "CONCLUDED" | "NOT_CONCLUDED"; reason: string } | null = null;
    if (a.now.getTime() >= new Date(m.closes_at).getTime()) stop = { outcome: "NOT_CONCLUDED", reason: "TIME" };
    else if (m.max_cost !== null && cost.measured >= Number(m.max_cost)) stop = { outcome: "NOT_CONCLUDED", reason: "COST" };
    else if (fullRound && round.every((r: any) => r.agrees)) stop = { outcome: "CONCLUDED", reason: "AGREED" };
    else if (turnNo >= m.max_turns) stop = { outcome: "NOT_CONCLUDED", reason: "MAX_TURNS" };
    else if (fullRound && round.every((r: any) => !r.new_position)) stop = { outcome: "NOT_CONCLUDED", reason: "NO_NEW_POSITION" };
    if (stop) { await closeIn(t, m, stop.outcome, stop.reason, a.now, a.actorRef); return { alreadyProcessed: false as const, meeting: { ...m, state: "CLOSED" }, status: stop.reason }; }
    await createTurn(t, m, turnNo + 1, a.now);
    return { alreadyProcessed: false as const, meeting: m, status: "NEXT_TURN" };
  });
}
export async function closeTurnMeeting(db: Db, a: { actorRef: string; code: string; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (typeof a.reason !== "string" || a.reason.trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason(>=3)"] });
  return db.tx(async (t) => {
    const [m] = await t.query<any>(`SELECT * FROM lumi_turn_meetings WHERE code=$1 FOR UPDATE`, [a.code]);
    if (!m) throw new LumiError("NOT_FOUND", 404);
    if (m.state === "CLOSED") return { alreadyProcessed: true as const };
    await closeIn(t, m, "NOT_CONCLUDED", "MANUAL", a.now, a.actorRef);
    return { alreadyProcessed: false as const };
  });
}
/** deadline sweep: an open meeting past its time closes with TIME (pending turns skipped) — checked every worker tick */
export async function turnMeetingTick(db: Db, now: Date): Promise<number> {
  const due = await db.query<any>(`SELECT code FROM lumi_turn_meetings WHERE state='OPEN' AND closes_at <= $1`, [iso(now)]);
  for (const d of due) await db.tx(async (t) => { const [m] = await t.query<any>(`SELECT * FROM lumi_turn_meetings WHERE code=$1 AND state='OPEN' FOR UPDATE`, [d.code]); if (m) await closeIn(t, m, "NOT_CONCLUDED", "TIME", now, "system:tick"); });
  return due.length;
}
export async function listTurnMeetings(db: Db) {
  const ms = await db.query<any>(`SELECT m.*, p.name AS project_name FROM lumi_turn_meetings m JOIN lumi_projects p ON p.id=m.project_id ORDER BY m.created_at DESC LIMIT 50`);
  const es = await db.query<any>(`SELECT e.meeting_id,e.turn_no,e.state,e.stance,e.new_position,e.agrees,a.name AS assistant_name FROM lumi_turn_entries e JOIN lumi_assistants a ON a.id=e.assistant_id ORDER BY e.turn_no`);
  const out: any[] = [];
  for (const m of ms) { const c = await turnMeetingCost(db, m.id); out.push({ ...m, max_cost: m.max_cost === null ? null : Number(m.max_cost), entries: es.filter((e: any) => e.meeting_id === m.id), cost_measured: c.measured, unknown_runs: c.unknown_runs, stop_note: m.stop_reason ? STOP_NOTE[m.stop_reason] : null }); }
  return out;
}
