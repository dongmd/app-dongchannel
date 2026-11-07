/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface (typed at the boundary in TDD 14.9) */
/**
 * Dong-Lumi M1 domain core (TDD 6.5, 8.5–8.8, 10). Plain SQL over a minimal `Db` interface so the same code runs on
 * `postgres` (production adapter, not wired in this change) and PGlite (tests, real PostgreSQL engine + the real 0000–0040 migrations).
 *
 * Nothing here talks to Hermes or Telegram: those are injected (`HermesPort`, `NotifyPort`). That is deliberate — the
 * integration contract with Hermes is still a spike (TDD 16 U1–U4, U16).
 */
import type { ProfileStatus } from "../lumi/admin";
import { randomUUID } from "node:crypto";

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export class LumiError extends Error {
  constructor(public code: string, public status: number, public data: Record<string, unknown> = {}) {
    super(code);
  }
}

// MCP tools (`server:tool` -> `tool.name`) plus the two built-in Hermes toolsets a RESTRICTED research assistant may need: `web` (read-only search/extract) and `skills` (read its business skill).
export const KNOWN_TOOLS = ["tasks.intake", "outputs.submit", "knowledge.context", "plan.submit.version", "web", "skills"] as const;
export const EXEC_FIELDS = [
  "run_deadline_seconds",
  "ack_deadline_seconds",
  "max_run_failures",
  "max_transport_attempts",
  "max_revision_rounds",
  "max_runs_per_day",
  "tool_allowlist",
] as const;

const iso = (d: Date) => d.toISOString();
const addSec = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

// ───────────────────────── authorization
export type Role = "OWNER" | "ADMIN" | "VIEWER";
/** Marks the current transaction as Telegram-originated: existing DB triggers (P3-R04/R02/R05) then refuse verification writes,
 *  publish-intent consumption and execution-state project changes for the rest of the transaction (W-V2TDD P3-R03/R04). */
export async function markTelegramAction(t: Db) {
  await t.query(`SELECT set_config('dc.in_telegram_action','on',true)`);
}

export async function roleOf(db: Db, ref: string): Promise<Role | null> {
  const r = await db.query<{ role: Role }>(`SELECT role FROM lumi_actors WHERE actor_ref=$1`, [ref]);
  return r[0]?.role ?? null;
}
export async function requireRole(db: Db, ref: string, roles: Role[]): Promise<Role> {
  const r = await roleOf(db, ref);
  if (!r || !roles.includes(r)) throw new LumiError("FORBIDDEN", 403);
  return r;
}

// ───────────────────────── intake parsing (pure)
export interface ParsedIntake {
  isTask: boolean;
  title?: string;
  projectId?: string;
  assigneeId?: string;
  missing: string[];
}
export function parseIntake(text: string, projects: { id: string; name: string }[], assistants: { id: string; name: string; slug: string }[]): ParsedIntake {
  const m = text.match(/^\s*(?:giao việc|giao viec|\/viec)\s*:?\s*([\s\S]+)$/i);
  if (!m) return { isTask: false, missing: [] };
  const body = m[1]!.trim();
  const low = body.toLowerCase();
  const project = projects.find((p) => low.includes(p.name.toLowerCase()));
  const assistant = assistants.find((a) => new RegExp(`\\b${a.slug.toLowerCase()}\\b`).test(low) || low.includes(a.name.toLowerCase()));
  const missing: string[] = [];
  if (!project) missing.push("project");
  if (!assistant) missing.push("assignee");
  return { isTask: true, title: body.slice(0, 120), projectId: project?.id, assigneeId: assistant?.id, missing };
}

// ───────────────────────── execution config gating (TDD 8.8)
export function missingExecConfig(a: Record<string, any>): string[] {
  const miss: string[] = [];
  for (const f of EXEC_FIELDS) {
    const v = a[f];
    if (f === "tool_allowlist") {
      const arr = Array.isArray(v) ? v : [];
      if (arr.length === 0) miss.push(f);
      else if (arr.some((t: string) => !(KNOWN_TOOLS as readonly string[]).includes(t))) miss.push("tool_allowlist(unknown_tool)");
    } else if (v === null || v === undefined || Number(v) <= 0) miss.push(f);
  }
  return miss;
}

export interface HermesPort {
  /** Tools the Hermes profile can actually call; null = cannot be determined (then activation is refused). */
  readProfileTools(profile: string): Promise<string[] | null>;
  dispatch(run: { runId: string; dispatchKey: string; taskCode: string; instruction: Record<string, unknown> }): Promise<
    | { kind: "accepted"; sessionRef?: string }
    | { kind: "rejected"; transient: boolean; message: string }
    | { kind: "uncertain"; message: string }
  >;
  /** Optional: gateway/Telegram/cron state per profile for the Admin screen (never tokens). null = could not read. */
  readProfileStatus?(): Promise<ProfileStatus[] | null>;
}
/** Optional: really stop a run on the Hermes side. confirmed=true only when the remote process is verified gone. */
export type StopResult = { confirmed: boolean; message?: string };
export interface HermesStopPort { stop(run: { runId: string; dispatchKey: string }): Promise<StopResult> }
export interface NotifyPort {
  /** Resolve normally = delivered. A stub or an unconfigured channel MUST resolve { delivered: false, reason } so the outbox never claims a delivery that did not happen. */
  send(payload: Record<string, unknown>): Promise<void | { delivered: boolean; reason?: string }>;
}

export async function setDispatchEnabled(db: Db, hermes: HermesPort, actorRef: string, assistantId: string, enabled: boolean, now: Date, opts: { trustVerifiedWithinMs?: number } = {}) {
  await requireRole(db, actorRef, ["OWNER"]);
  const [a] = await db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [assistantId]);
  if (!a) throw new LumiError("NOT_FOUND", 404);
  if (enabled) {
    const missing = missingExecConfig(a);
    if (missing.length) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing });
    if (a.connection_state !== "VERIFIED") throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: ["connection_state(VERIFIED)"] });
    if (!a.hermes_profile) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: ["hermes_profile"] });
    if (a.capability_mode === "DECLARED_FULL") {
      // The owner declared that this assistant keeps ALL its tools (TDD 8.11). We do not refuse it for having them; we require the
      // explicit acknowledgement that is recorded in the audit log. Tools are NOT the authority to act outside: that is grants (8.11.3).
      if (!a.capability_ack_at) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: ["capability_ack"] });
    } else if (opts.trustVerifiedWithinMs && a.connection_checked_at && now.getTime() - new Date(a.connection_checked_at).getTime() <= opts.trustVerifiedWithinMs) {
      // REAL mode: the web process cannot reach Hermes; the worker's connection check (same rule: profile tools within the allowlist) is the evidence.
    } else {
      const tools = await hermes.readProfileTools(a.hermes_profile);
      if (tools === null) throw new LumiError("PROFILE_TOOLS_UNKNOWN", 422);
      const extra = tools.filter((t) => !a.tool_allowlist.includes(t));
      if (extra.length) throw new LumiError("PROFILE_EXCEEDS_ALLOWLIST", 422, { extra });
    }
  }
  await db.tx(async (t) => {
    await t.query(`UPDATE lumi_assistants SET dispatch_enabled=$2 WHERE id=$1`, [assistantId, enabled]);
    await audit(t, "assistant.dispatch_enabled", actorRef, { assistantId, enabled }, now);
    if (enabled) await releaseWaiting(t, assistantId, now);
  });
}

/** Tasks that waited for a not-yet-ready assistant get their first run when dispatch is switched on. */
export async function releaseWaiting(t: Db, assistantId: string, now: Date): Promise<number> {
  const [asst] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [assistantId]);
  const waiting = await t.query<any>(`SELECT id,title,description,expected_output FROM tasks WHERE owner_assistant_id=$1 AND status='WAITING_ASSISTANT' ORDER BY created_at FOR UPDATE`, [assistantId]);
  for (const w of waiting) {
    await createRun(t, w.id, asst, "INITIAL", now, { text: w.description ?? w.title, title: w.title, expected_output: w.expected_output });
    await t.query(`UPDATE tasks SET status='QUEUED',updated_at=$2 WHERE id=$1`, [w.id, iso(now)]);
    await activity(t, w.id, "task.released", now, { assistantId });
  }
  return waiting.length;
}

export async function audit(db: Db, action: string, actor: string, data: Record<string, unknown>, now: Date) {
  // Same transaction as the change (SR-08). audit_events is the existing append-only table.
  await db.query(
    `INSERT INTO audit_events (actor_type, actor_id, action, entity_type, entity_id, after_json, request_id, result) VALUES ('user',$1,$2,'lumi',$3,$4::jsonb,$5,'ok')`,
    [actor, action, String(data.assistantId ?? data.taskId ?? data.draftId ?? data.outputId ?? ""), JSON.stringify({ ...data, at: iso(now) }), randomUUID()],
  );
}
export async function activity(db: Db, taskId: string, type: string, now: Date, payload: Record<string, unknown> = {}) {
  await db.query(`INSERT INTO task_activities (task_id,event_type,status,payload_redacted,occurred_at) VALUES ($1,$2,'ok',$3::jsonb,$4)`, [taskId, type, JSON.stringify(payload), iso(now)]);
}
export async function flag(db: Db, key: string): Promise<boolean> {
  const r = await db.query<{ value: any }>(`SELECT value FROM lumi_system_flags WHERE key=$1`, [key]);
  return r[0]?.value === true;
}
export async function setFlag(db: Db, actorRef: string, key: string, value: boolean, now: Date) {
  await requireRole(db, actorRef, ["OWNER"]);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,set_by=EXCLUDED.set_by,set_at=EXCLUDED.set_at`, [key, JSON.stringify(value), actorRef, iso(now)]);
  await audit(db, `flag.${key}`, actorRef, { value }, now);
}

// ───────────────────────── intake drafts (TDD 6.5 d, 8.6.1–8.6.3)
export interface NewDraft {
  sourceKey: string;
  channel: "TELEGRAM" | "WEB";
  actorRef: string;
  assistantId?: string | null;
  text: string;
  ttlSeconds: number;
  now: Date;
}
export async function createDraft(db: Db, d: NewDraft) {
  await requireRole(db, d.actorRef, ["OWNER", "ADMIN"]);
  const projects = await db.query<any>(`SELECT id,name FROM lumi_projects WHERE status='ACTIVE'`);
  const assistants = await db.query<any>(`SELECT id,name,slug FROM lumi_assistants WHERE status='ACTIVE'`);
  const p = parseIntake(d.text, projects, assistants);
  if (!p.isTask) return { noTask: true as const };
  const parsed = { title: p.title, project_id: p.projectId ?? null, assignee_id: p.assigneeId ?? null };
  const ins = await db.query<any>(
    `INSERT INTO lumi_intake_drafts (source_key,channel,actor_ref,assistant_id,raw_text,parsed,missing,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (source_key) DO NOTHING RETURNING *`,
    [d.sourceKey, d.channel, d.actorRef, d.assistantId ?? null, d.text.slice(0, 4000), JSON.stringify(parsed), p.missing, iso(addSec(d.now, d.ttlSeconds))],
  );
  if (ins[0]) return { draft: ins[0], created: true as const };
  const [existing] = await db.query<any>(`SELECT * FROM lumi_intake_drafts WHERE source_key=$1`, [d.sourceKey]);
  if (existing.actor_ref !== d.actorRef) throw new LumiError("FORBIDDEN", 403); // same source_key from a different identity
  return { draft: existing, created: false as const };
}

async function draftAccess(db: Db, draft: any, actorRef: string) {
  const role = await roleOf(db, actorRef);
  if (role === "OWNER" || (draft.actor_ref === actorRef && role === "ADMIN")) return;
  throw new LumiError("FORBIDDEN", 403);
}

export async function patchDraft(db: Db, actorRef: string, draftId: string, version: number, changes: { projectId?: string; assigneeId?: string; title?: string }, now: Date) {
  return db.tx(async (t) => {
    const [d] = await t.query<any>(`SELECT * FROM lumi_intake_drafts WHERE id=$1 FOR UPDATE`, [draftId]);
    if (!d) throw new LumiError("NOT_FOUND", 404);
    await draftAccess(t, d, actorRef);
    if (d.state !== "OPEN") throw new LumiError("INVALID_TRANSITION", 409, { state: d.state });
    if (new Date(d.expires_at) <= now) throw new LumiError("GONE", 410);
    if (d.version !== version) throw new LumiError("STALE_VERSION", 409, { current: d });
    const parsed = { ...d.parsed };
    if (changes.projectId) parsed.project_id = changes.projectId;
    if (changes.assigneeId) parsed.assignee_id = changes.assigneeId;
    if (changes.title) parsed.title = changes.title;
    const missing: string[] = [];
    if (!parsed.project_id) missing.push("project");
    if (!parsed.assignee_id) missing.push("assignee");
    const [u] = await t.query<any>(`UPDATE lumi_intake_drafts SET parsed=$2::jsonb,missing=$3,version=version+1,updated_at=$4 WHERE id=$1 RETURNING *`, [draftId, JSON.stringify(parsed), missing, iso(now)]);
    return u;
  });
}

export async function confirmDraft(db: Db, actorRef: string, draftId: string, now: Date) {
  const r = await confirmDraftTx(db, actorRef, draftId, now);
  // The EXPIRED mark must be committed; throwing inside the transaction would roll it back.
  if ("expired" in r) throw new LumiError("GONE", 410);
  return r;
}
async function confirmDraftTx(db: Db, actorRef: string, draftId: string, now: Date) {
  return db.tx(async (t): Promise<{ task: any; alreadyProcessed: boolean } | { expired: true }> => {
    const [d] = await t.query<any>(`SELECT * FROM lumi_intake_drafts WHERE id=$1 FOR UPDATE`, [draftId]);
    if (!d) throw new LumiError("NOT_FOUND", 404);
    await draftAccess(t, d, actorRef);
    if (d.channel === "TELEGRAM") await markTelegramAction(t);
    if (d.state === "CONFIRMED") {
      const [task] = await t.query<any>(`SELECT id,code,status FROM tasks WHERE id=$1`, [d.task_id]);
      return { task, alreadyProcessed: true as const };
    }
    if (d.state !== "OPEN") throw new LumiError("INVALID_TRANSITION", 409, { state: d.state });
    if (new Date(d.expires_at) <= now) {
      await t.query(`UPDATE lumi_intake_drafts SET state='EXPIRED',updated_at=$2 WHERE id=$1`, [draftId, iso(now)]);
      return { expired: true as const };
    }
    const missing: string[] = [];
    if (!d.parsed.project_id) missing.push("project");
    if (!d.parsed.assignee_id) missing.push("assignee");
    if (missing.length) throw new LumiError("VALIDATION_ERROR", 400, { missing });
    const [proj] = await t.query<any>(`SELECT * FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [d.parsed.project_id]);
    const [asst] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [d.parsed.assignee_id]);
    if (!proj || !asst) throw new LumiError("NOT_FOUND", 404);
    const ready = asst.connection_state === "VERIFIED" && asst.dispatch_enabled === true;
    const [task] = await t.query<any>(
      `INSERT INTO tasks (code,profile_slug,title,description,status,review_status,project_id,owner_kind,owner_assistant_id,source_key,created_at,updated_at)
       VALUES ('DL-'||lpad(nextval('lumi_task_code_seq')::text,3,'0'),$1,$2,$8,$3::task_status,'NONE',$4,'BOT',$5,$6,$7,$7) RETURNING id,code,status`,
      [asst.hermes_profile ?? "unassigned", d.parsed.title, ready ? "QUEUED" : "WAITING_ASSISTANT", proj.id, asst.id, d.source_key, iso(now), d.raw_text],
    );
    await activity(t, task.id, "task.created", now, { source: d.channel });
    if (ready) await createRun(t, task.id, asst, "INITIAL", now, { text: d.raw_text });
    await t.query(`UPDATE lumi_intake_drafts SET state='CONFIRMED',task_id=$2,confirmed_by=$3,confirmed_at=$4,updated_at=$4 WHERE id=$1`, [draftId, task.id, actorRef, iso(now)]);
    await audit(t, "intake.confirmed", actorRef, { taskId: task.id }, now); // the draft id is a confirm credential: never written to the permanent audit log (W-V2TDD P3-R03)
    return { task, alreadyProcessed: false as const };
  });
}

// ───────────────────────── runs and outbox
/** `LUMI_RUN_TOTAL_CAPS="aff-trial=8"` -> 8; null when the assistant has no total cap configured. */
export function runTotalCap(slug: string, env: string | undefined = process.env.LUMI_RUN_TOTAL_CAPS): number | null {
  for (const part of (env ?? "").split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (k === slug && v && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}
export async function createRun(t: Db, taskId: string, asst: any, kind: "INITIAL" | "RETRY" | "REVISION" | "REASSIGN" | "CONTINUATION", now: Date, instruction: Record<string, unknown>) {
  if (asst.max_runs_per_day != null) {
    const [c] = await t.query<{ n: string }>(`SELECT count(*)::text AS n FROM lumi_task_runs WHERE assistant_id=$1 AND created_at >= date_trunc('day',$2::timestamptz)`, [asst.id, iso(now)]);
    if (Number(c!.n) >= asst.max_runs_per_day) throw new LumiError("DAILY_CAP", 409, { max_runs_per_day: asst.max_runs_per_day });
  }
  // Total cap per assistant across ALL days (owner-approved trial budget): LUMI_RUN_TOTAL_CAPS="slug=8,other=3". A day boundary must not reset it.
  const totalCap = runTotalCap(asst.slug);
  if (totalCap !== null) {
    const [tc] = await t.query<{ n: string }>(`SELECT count(*)::text AS n FROM lumi_task_runs WHERE assistant_id=$1`, [asst.id]);
    if (Number(tc!.n) >= totalCap) throw new LumiError("TOTAL_CAP", 409, { max_runs_total: totalCap });
  }
  const n = (await t.query<{ n: number }>(`SELECT coalesce(max(attempt_no),0)+1 AS n FROM lumi_task_runs WHERE task_id=$1`, [taskId]))[0]!.n;
  const id = randomUUID();
  await t.query(`INSERT INTO lumi_task_runs (id,task_id,attempt_no,assistant_id,run_kind,dispatch_key,instruction_snapshot,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [id, taskId, n, asst.id, kind, `run:${id}`, JSON.stringify(instruction), iso(now)]);
  await t.query(`INSERT INTO lumi_outbox (kind,aggregate_type,aggregate_id,dedupe_key,payload,max_attempts,next_attempt_at,created_at) VALUES ('DISPATCH_RUN','run',$1,$2,$3::jsonb,$4,$5,$5)`, [id, `dispatch:${id}`, JSON.stringify({ runId: id }), asst.max_transport_attempts ?? 1, iso(now)]);
  return id;
}

export interface OutboxRow {
  id: string; kind: string; aggregate_id: string; payload: any; attempts: number; max_attempts: number; lease_owner: string; lease_epoch: number;
}
/** `slugs` (optional) restricts DISPATCH_RUN/STOP_RUN/VERIFY_ASSISTANT rows to those assistants, so a worker bound to one adapter (simulated OR real) never claims,
 *  fails or resends the other lane's runs. Rows of other kinds (notifications) are claimable by anyone. */
export async function claimOutbox(db: Db, worker: string, leaseSeconds: number, now: Date, slugs?: string[]): Promise<OutboxRow | null> {
  const r = await db.query<OutboxRow>(
    `UPDATE lumi_outbox SET state='LEASED',lease_owner=$1,lease_epoch=lease_epoch+1,lease_expires_at=$3::timestamptz + make_interval(secs => $2),attempts=attempts+1
     WHERE id=(SELECT id FROM lumi_outbox WHERE state IN ('PENDING','LEASED') AND next_attempt_at <= $3::timestamptz
               AND (lease_expires_at IS NULL OR lease_expires_at < $3::timestamptz)
               AND ($4::text[] IS NULL OR kind NOT IN ('DISPATCH_RUN','STOP_RUN','VERIFY_ASSISTANT')
                    OR (kind IN ('DISPATCH_RUN','STOP_RUN') AND EXISTS (SELECT 1 FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id WHERE r.id::text = lumi_outbox.aggregate_id::text AND a.slug = ANY($4::text[])))
                    OR (kind = 'VERIFY_ASSISTANT' AND EXISTS (SELECT 1 FROM lumi_assistants a2 WHERE a2.id::text = lumi_outbox.aggregate_id::text AND a2.slug = ANY($4::text[]))))
               ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id,kind,aggregate_id,payload,attempts,max_attempts,lease_owner,lease_epoch`,
    [worker, leaseSeconds, iso(now), slugs && slugs.length ? slugs : null],
  );
  return r[0] ?? null;
}
type Finish = { to: "DONE"; note?: string } | { to: "RETRY"; delaySec: number; error: string } | { to: "DEAD"; error: string } | { to: "DEFER"; delaySec: number };
/** Returns false when the lease was lost (stale worker). Caller must then stop without writing anything else. */
export async function finishOutbox(db: Db, row: OutboxRow, f: Finish, now: Date): Promise<boolean> {
  const where = `id=$1 AND state='LEASED' AND lease_owner=$2 AND lease_epoch=$3`;
  const base = [row.id, row.lease_owner, row.lease_epoch];
  let sql: string; let params: unknown[];
  if (f.to === "DONE") { sql = `UPDATE lumi_outbox SET state='DONE',done_at=$4,last_error=$5,lease_owner=NULL,lease_expires_at=NULL WHERE ${where} RETURNING id`; params = [...base, iso(now), f.note ?? null]; }
  else if (f.to === "DEAD") { sql = `UPDATE lumi_outbox SET state='DEAD',last_error=$4,lease_owner=NULL,lease_expires_at=NULL WHERE ${where} RETURNING id`; params = [...base, f.error]; }
  else if (f.to === "RETRY") { sql = `UPDATE lumi_outbox SET state='PENDING',last_error=$4,next_attempt_at=$5::timestamptz + make_interval(secs => $6),lease_owner=NULL,lease_expires_at=NULL WHERE ${where} RETURNING id`; params = [...base, f.error, iso(now), f.delaySec]; }
  else { sql = `UPDATE lumi_outbox SET state='PENDING',attempts=attempts-1,next_attempt_at=$4::timestamptz + make_interval(secs => $5),lease_owner=NULL,lease_expires_at=NULL WHERE ${where} RETURNING id`; params = [...base, iso(now), f.delaySec]; }
  return (await db.query(sql, params)).length === 1;
}
/** Extends the lease only for the worker/epoch that still owns it. false => lease lost; the caller must stop. */
export async function renewOutbox(db: Db, row: OutboxRow, leaseSeconds: number, now: Date): Promise<boolean> {
  const r = await db.query(
    `UPDATE lumi_outbox SET lease_expires_at=$4::timestamptz + make_interval(secs => $5)
     WHERE id=$1 AND state='LEASED' AND lease_owner=$2 AND lease_epoch=$3 AND lease_expires_at > $4::timestamptz RETURNING id`,
    [row.id, row.lease_owner, row.lease_epoch, iso(now), leaseSeconds],
  );
  return r.length === 1;
}

export const backoff = (attempts: number) => Math.min(300, 2 ** attempts * 5);

export async function enqueueNotify(db: Db, key: string, payload: Record<string, unknown>, now: Date, maxAttempts = 5) {
  await db.query(`INSERT INTO lumi_outbox (kind,dedupe_key,payload,max_attempts,next_attempt_at,created_at) VALUES ('TELEGRAM_NOTIFY',$1,$2::jsonb,$3,$4,$4) ON CONFLICT (dedupe_key) DO NOTHING`, [key, JSON.stringify(payload), maxAttempts, iso(now)]);
}

/** IMP-02 (OFC-04): the REAL connection check. Runs on the worker host (the only place that can reach Hermes) and is the ONLY writer of connection_state=VERIFIED. */
async function verifyAssistantRow(db: Db, hermes: HermesPort, row: OutboxRow, now: Date) {
  const [a] = await db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [row.aggregate_id]);
  let state: "VERIFIED" | "FAILED" = "FAILED"; let err: string | null = null; let tools: string[] | null = null;
  if (!a || a.status !== "ACTIVE") err = "ASSISTANT_NOT_ACTIVE";
  else if (!a.hermes_profile) err = "NO_PROFILE";
  else {
    try { tools = await hermes.readProfileTools(a.hermes_profile); } catch { tools = null; }
    if (tools === null) err = "PROFILE_TOOLS_UNKNOWN: profile không tồn tại hoặc không đọc được từ Hermes";
    else if (a.capability_mode === "DECLARED_FULL") { if (a.capability_ack_at) state = "VERIFIED"; else err = "capability_ack: chưa có xác nhận công cụ rộng"; }
    else {
      const extra = tools.filter((t) => !a.tool_allowlist.includes(t));
      const needed = ["knowledge.context", "outputs.submit"].filter((t) => !tools!.includes(t));
      if (extra.length) err = `PROFILE_EXCEEDS_ALLOWLIST: ${extra.join(", ")}`;
      else if (needed.length) err = `MISSING_TOOLS: ${needed.join(", ")}`;
      else state = "VERIFIED";
    }
  }
  return db.tx(async (t) => {
    const mine = await t.query(`SELECT 1 FROM lumi_outbox WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND state='LEASED'`, [row.id, row.lease_owner, row.lease_epoch]);
    if (mine.length !== 1) return { kind: row.kind, outcome: "lost_lease" };
    if (a) {
      // a failed check on an assistant that was dispatching switches dispatch OFF (never keep sending to something that no longer verifies)
      await t.query(`UPDATE lumi_assistants SET connection_state=$2,connection_checked_at=$3,connection_error=$4,dispatch_enabled=CASE WHEN $2='VERIFIED' THEN dispatch_enabled ELSE false END WHERE id=$1`, [a.id, state, iso(now), err]);
      await audit(t, "assistant.verified", "system:worker", { assistantId: a.id, state, error: err, tools }, now);
    }
    await finishOutbox(t, row, { to: "DONE", note: state === "VERIFIED" ? undefined : `VERIFY_FAILED: ${err}` }, now);
    return { kind: row.kind, outcome: state === "VERIFIED" ? "verified" : "verify_failed" };
  });
}

export async function processOutbox(db: Db, deps: { hermes: HermesPort & Partial<HermesStopPort>; notify: NotifyPort; clock?: () => Date; heartbeatMs?: number; slugs?: string[] }, worker: string, now: Date, leaseSeconds = 60): Promise<{ kind: string; outcome: string } | null> {
  const row = await claimOutbox(db, worker, leaseSeconds, now, deps.slugs);
  if (!row) return null;
  if (row.kind === "TELEGRAM_NOTIFY") {
    try {
      const r = await deps.notify.send(row.payload);
      if (r && r.delivered === false) { await finishOutbox(db, row, { to: "DONE", note: `NOT_DELIVERED: ${r.reason ?? "kênh chưa nối"}` }, now); return { kind: row.kind, outcome: "not_delivered" }; } // closed, but NOT reported as sent
      await finishOutbox(db, row, { to: "DONE" }, now); return { kind: row.kind, outcome: "sent" };
    }
    catch (e) {
      // Notification failures only touch the outbox row. They must never change a task (TDD 8.5).
      const dead = row.attempts >= row.max_attempts;
      await finishOutbox(db, row, dead ? { to: "DEAD", error: String(e) } : { to: "RETRY", delaySec: backoff(row.attempts), error: String(e) }, now);
      return { kind: row.kind, outcome: dead ? "dead" : "retry" };
    }
  }
  if (row.kind === "VERIFY_ASSISTANT") return verifyAssistantRow(db, deps.hermes, row, now);
  if (row.kind === "STOP_RUN") {
    // The app stopped WAITING when it enqueued this; here we try to stop the REMOTE run and only claim "CONFIRMED" when verified.
    const runId = row.aggregate_id;
    const [r] = await db.query<any>(`SELECT dispatch_key FROM lumi_task_runs WHERE id=$1`, [runId]);
    let res: { confirmed: boolean; message?: string };
    try { res = deps.hermes.stop ? await deps.hermes.stop({ runId, dispatchKey: r.dispatch_key }) : { confirmed: false, message: "adapter has no stop()" }; }
    catch (e) { res = { confirmed: false, message: String(e) }; }
    const final = res.confirmed || row.attempts >= row.max_attempts;
    if (!final) { await finishOutbox(db, row, { to: "RETRY", delaySec: backoff(row.attempts), error: res.message ?? "stop not confirmed" }, now); return { kind: row.kind, outcome: "retry" }; }
    return db.tx(async (t) => {
      const mine = await t.query(`SELECT 1 FROM lumi_outbox WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND state='LEASED'`, [row.id, row.lease_owner, row.lease_epoch]);
      if (mine.length !== 1) return { kind: row.kind, outcome: "lost_lease" };
      await t.query(`UPDATE lumi_task_runs SET remote_stop_state=$2 WHERE id=$1`, [runId, res.confirmed ? "CONFIRMED" : "UNKNOWN"]);
      await activity(t, (await t.query<any>(`SELECT task_id FROM lumi_task_runs WHERE id=$1`, [runId]))[0].task_id, res.confirmed ? "run.remote_stop_confirmed" : "run.remote_stop_unknown", now, { runId });
      await finishOutbox(t, row, { to: "DONE" }, now);
      return { kind: row.kind, outcome: res.confirmed ? "stopped" : "stop_unknown" };
    });
  }
  if (row.kind !== "DISPATCH_RUN") { await finishOutbox(db, row, { to: "DEAD", error: `unknown kind ${row.kind}` }, now); return { kind: row.kind, outcome: "dead" }; }

  const runId = row.aggregate_id;
  const [run] = await db.query<any>(`SELECT r.*, t.code AS task_code, t.status AS task_status, (t.plan_id IS NOT NULL AND t.plan_task_key IS NULL) AS is_planning_run, CASE WHEN t.plan_task_key IS NOT NULL THEN pl.status END AS plan_status FROM lumi_task_runs r JOIN tasks t ON t.id=r.task_id LEFT JOIN lumi_plans pl ON pl.id=t.plan_id WHERE r.id=$1`, [runId]);
  const [a] = await db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [run.assistant_id]);
  if (run.state !== "PENDING") { await finishOutbox(db, row, { to: "DONE" }, now); return { kind: row.kind, outcome: "skipped_not_pending" }; } // never resend a run Hermes may already have
  // IMP-01: a TASK run of a plan paused for budget adjustment is deferred (like dispatch_paused), never sent. Planning runs are NOT deferred: the owner must be able to raise the ceiling.
  if ((await flag(db, "emergency_stop")) || !(await flag(db, "m1_enabled")) || a.dispatch_paused || !a.dispatch_enabled || run.plan_status === "PAUSED_ADJUSTMENT") {
    await finishOutbox(db, row, { to: "DEFER", delaySec: 30 }, now);
    return { kind: row.kind, outcome: "deferred" };
  }
  // Record "sending" under the lease BEFORE the external call so that a crash leaves a trace (state DISPATCHED + ack deadline).
  const marked = await db.query(`UPDATE lumi_task_runs SET state='DISPATCHED',ack_deadline_at=$2::timestamptz + make_interval(secs => $3) WHERE id=$1 AND state='PENDING' AND EXISTS (SELECT 1 FROM lumi_outbox WHERE id=$4 AND lease_owner=$5 AND lease_epoch=$6 AND state='LEASED') RETURNING id`, [runId, iso(now), a.ack_deadline_seconds, row.id, row.lease_owner, row.lease_epoch]);
  if (marked.length !== 1) return { kind: row.kind, outcome: "lost_lease" };

  let res: Awaited<ReturnType<HermesPort["dispatch"]>>;
  // Keep the lease alive while the external call is in flight (TDD 8.5). A failed renewal means a newer worker owns the row.
  const clock = deps.clock ?? (() => new Date());
  const hb = deps.heartbeatMs ? setInterval(() => { renewOutbox(db, row, leaseSeconds, clock()).catch(() => {}); }, deps.heartbeatMs) : null;
  try { res = await deps.hermes.dispatch({ runId, dispatchKey: run.dispatch_key, taskCode: run.task_code, instruction: { ...(run.instruction_snapshot ?? {}), run_purpose: run.is_planning_run ? "PLAN" : "TASK" } }); }
  catch (e) { res = { kind: "uncertain", message: String(e) }; } // an exception does not tell us whether Hermes received the command
  finally { if (hb) clearInterval(hb); }

  return db.tx(async (t) => {
    const stillMine = await t.query(`SELECT 1 FROM lumi_outbox WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND state='LEASED'`, [row.id, row.lease_owner, row.lease_epoch]);
    if (stillMine.length !== 1) return { kind: row.kind, outcome: "lost_lease" }; // newer worker owns the row; it will see state DISPATCHED and will not resend
    if (res.kind === "accepted") {
      if (res.sessionRef) await t.query(`UPDATE lumi_task_runs SET hermes_session_ref=$2 WHERE id=$1`, [runId, res.sessionRef]);
      await finishOutbox(t, row, { to: "DONE" }, now);
      return { kind: row.kind, outcome: "accepted" };
    }
    if (res.kind === "uncertain") {
      await t.query(`UPDATE lumi_task_runs SET state='DISPATCH_UNCERTAIN',error_message=$2 WHERE id=$1`, [runId, res.message]);
      await t.query(`UPDATE tasks SET needs_decision=true,updated_at=$2 WHERE id=$1`, [run.task_id, iso(now)]);
      await activity(t, run.task_id, "run.dispatch_uncertain", now, { runId });
      await finishOutbox(t, row, { to: "DONE" }, now); // NOT retried: resending could start the run twice
      return { kind: row.kind, outcome: "uncertain" };
    }
    const exhausted = !res.transient || row.attempts >= row.max_attempts;
    if (!exhausted) {
      await t.query(`UPDATE lumi_task_runs SET state='PENDING',ack_deadline_at=NULL WHERE id=$1`, [runId]);
      await finishOutbox(t, row, { to: "RETRY", delaySec: backoff(row.attempts), error: res.message }, now);
      return { kind: row.kind, outcome: "retry" };
    }
    await t.query(`UPDATE lumi_task_runs SET state='FAILED',error_code='DISPATCH_FAILED',error_message=$2,finished_at=$3 WHERE id=$1`, [runId, res.message, iso(now)]);
    // Only fail the task if it is still waiting on exactly this run.
    await t.query(`UPDATE tasks SET status='FAILED',error_code='DISPATCH_FAILED',error_message=$2,updated_at=$3 WHERE id=$1 AND status='QUEUED'`, [run.task_id, res.message, iso(now)]);
    await finishOutbox(t, row, { to: "DEAD", error: res.message }, now);
    return { kind: row.kind, outcome: "dead" };
  });
}

/** Hermes (or the bot) confirms it started the run. */
export async function ackRun(db: Db, assistantSlug: string, runId: string, now: Date, sessionRef?: string) {
  return db.tx(async (t) => {
    const [r] = await t.query<any>(`SELECT r.*, a.slug, a.run_deadline_seconds FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id WHERE r.id=$1 FOR UPDATE OF r`, [runId]);
    if (!r) throw new LumiError("NOT_FOUND", 404);
    if (`bot:${r.slug}` !== `bot:${assistantSlug}`) throw new LumiError("FORBIDDEN", 403);
    if (r.state === "RUNNING") return { alreadyProcessed: true };
    if (!["DISPATCHED", "DISPATCH_UNCERTAIN"].includes(r.state)) throw new LumiError("INVALID_TRANSITION", 409, { state: r.state });
    await t.query(`UPDATE lumi_task_runs SET state='RUNNING',acked_at=$2,started_at=$2,deadline_at=$2::timestamptz + make_interval(secs => $3),hermes_session_ref=coalesce($4,hermes_session_ref) WHERE id=$1`, [runId, iso(now), r.run_deadline_seconds, sessionRef ?? null]);
    await t.query(`UPDATE tasks SET status='RUNNING',needs_decision=false,started_at=coalesce(started_at,$2),updated_at=$2 WHERE id=$1 AND status IN ('QUEUED','FAILED','ON_HOLD')`, [r.task_id, iso(now)]);
    return { alreadyProcessed: false };
  });
}

export async function enqueueStop(t: Db, runId: string, now: Date, maxAttempts = 3) {
  await t.query(`INSERT INTO lumi_outbox (kind,aggregate_type,aggregate_id,dedupe_key,payload,max_attempts,next_attempt_at,created_at) VALUES ('STOP_RUN','run',$1,$2,$3::jsonb,$4,$5,$5) ON CONFLICT (dedupe_key) DO NOTHING`, [runId, `stop:${runId}`, JSON.stringify({ runId }), maxAttempts, now.toISOString()]);
}

export async function reap(db: Db, now: Date) {
  const unc = await db.query<any>(`UPDATE lumi_task_runs SET state='DISPATCH_UNCERTAIN' WHERE state='DISPATCHED' AND ack_deadline_at <= $1 RETURNING id,task_id`, [iso(now)]);
  for (const r of unc) await db.query(`UPDATE tasks SET needs_decision=true,updated_at=$2 WHERE id=$1`, [r.task_id, iso(now)]);
  const to = await db.query<any>(`UPDATE lumi_task_runs SET state='TIMED_OUT',error_code='TIMED_OUT',finished_at=$1 WHERE state='RUNNING' AND deadline_at <= $1 RETURNING id,task_id`, [iso(now)]);
  for (const r of to) await db.query(`UPDATE tasks SET status='FAILED',error_code='TIMED_OUT',updated_at=$2 WHERE id=$1 AND status='RUNNING'`, [r.task_id, iso(now)]);
  for (const r of to) await enqueueStop(db, r.id, now); // the run overran: stop the model for real, do not just stop waiting
  return { uncertain: unc.length, timedOut: to.length };
}

// ───────────────────────── outputs (TDD 8.6.5, 8.7)
export async function submitOutput(db: Db, a: { taskId: string; runId?: string; actorRef: string; content: string; idempotencyKey: string; now: Date; final?: boolean }) {
  return db.tx(async (t) => {
    const [task] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [a.taskId]);
    if (!task) throw new LumiError("NOT_FOUND", 404);
    const dup = await t.query<any>(`SELECT * FROM lumi_task_outputs WHERE task_id=$1 AND idempotency_key=$2`, [a.taskId, a.idempotencyKey]);
    let run: any = null;
    if (a.runId) {
      [run] = await t.query<any>(`SELECT r.*, s.slug FROM lumi_task_runs r JOIN lumi_assistants s ON s.id=r.assistant_id WHERE r.id=$1 AND r.task_id=$2 FOR UPDATE OF r`, [a.runId, a.taskId]);
      if (!run) throw new LumiError("NOT_FOUND", 404);
      if (a.actorRef !== `bot:${run.slug}`) throw new LumiError("FORBIDDEN", 403);
    } else {
      if (task.owner_kind !== "HUMAN" || task.owner_actor_ref !== a.actorRef) throw new LumiError("FORBIDDEN", 403);
    }
    if (dup[0]) return { output: dup[0], alreadyProcessed: true as const };
    const v = (await t.query<{ v: number }>(`SELECT coalesce(max(version),0)+1 AS v FROM lumi_task_outputs WHERE task_id=$1`, [a.taskId]))[0]!.v;
    const open = run ? ["DISPATCHED", "DISPATCH_UNCERTAIN", "RUNNING"].includes(run.state) : task.status === "RUNNING";
    if (run && run.state === "SUCCEEDED") throw new LumiError("STALE_VERSION", 409, { reason: "run_already_submitted" });
    if (!open) {
      if (!run) throw new LumiError("INVALID_TRANSITION", 409, { state: task.status });
      // Late result: store for audit only. Task, current output and run stay untouched (never reopens CANCELLED/COMPLETED).
      const [o] = await t.query<any>(`INSERT INTO lumi_task_outputs (task_id,run_id,version,content,submitted_by,idempotency_key,late,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,true,'LATE_SAVED',$7) RETURNING *`, [a.taskId, a.runId, v, a.content, a.actorRef, a.idempotencyKey, iso(a.now)]);
      await activity(t, a.taskId, "output.late_saved", a.now, { outputId: o.id, runState: run.state });
      await enqueueNotify(t, `notify:late:${o.id}`, { type: "LATE_OUTPUT", taskCode: task.code }, a.now);
      return { output: o, alreadyProcessed: false as const, late: true as const };
    }
    if (!["QUEUED", "RUNNING"].includes(task.status)) throw new LumiError("INVALID_TRANSITION", 409, { state: task.status });
    if (run && a.final === false) {
      // CHECKPOINT (not for review): the run ends here, the work continues in a NEW run, within max_continuations (TDD 8.11.6).
      const [asst] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [run.assistant_id]);
      const [o] = await t.query<any>(`INSERT INTO lumi_task_outputs (task_id,run_id,version,content,submitted_by,idempotency_key,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,'PROGRESS',$7) RETURNING *`, [a.taskId, run.id, v, a.content, a.actorRef, a.idempotencyKey, iso(a.now)]);
      await t.query(`UPDATE lumi_task_runs SET state='SUCCEEDED',finished_at=$2,started_at=coalesce(started_at,$2),checkpoint=$3 WHERE id=$1`, [run.id, iso(a.now), a.content]);
      const used = (await t.query<{ n: string }>(`SELECT count(*)::text AS n FROM lumi_task_runs WHERE task_id=$1 AND run_kind='CONTINUATION'`, [a.taskId]))[0]!.n;
      await activity(t, a.taskId, "output.checkpoint", a.now, { version: v, continuations: Number(used) });
      if (Number(used) < asst.max_continuations) {
        await createRun(t, a.taskId, asst, "CONTINUATION", a.now, { continuation_of: run.id, title: task.title });
        await t.query(`UPDATE tasks SET status='QUEUED',needs_decision=false,updated_at=$2 WHERE id=$1`, [a.taskId, iso(a.now)]);
        return { output: o, alreadyProcessed: false as const, late: false as const, checkpoint: "CONTINUING" as const };
      }
      await t.query(`UPDATE tasks SET status='ON_HOLD',hold_reason='CONTINUATION_LIMIT',needs_decision=true,updated_at=$2 WHERE id=$1`, [a.taskId, iso(a.now)]);
      await enqueueNotify(t, `notify:hold:${o.id}`, { type: "NEEDS_DECISION", taskCode: task.code, reason: "CONTINUATION_LIMIT" }, a.now);
      return { output: o, alreadyProcessed: false as const, late: false as const, checkpoint: "LIMIT_REACHED" as const };
    }
    const [o] = await t.query<any>(`INSERT INTO lumi_task_outputs (task_id,run_id,version,content,submitted_by,idempotency_key,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,'SUBMITTED',$7) RETURNING *`, [a.taskId, a.runId ?? null, v, a.content, a.actorRef, a.idempotencyKey, iso(a.now)]);
    if (task.current_output_id) await t.query(`UPDATE lumi_task_outputs SET state='SUPERSEDED' WHERE id=$1 AND state='SUBMITTED'`, [task.current_output_id]);
    if (run) await t.query(`UPDATE lumi_task_runs SET state='SUCCEEDED',finished_at=$2,started_at=coalesce(started_at,$2) WHERE id=$1`, [run.id, iso(a.now)]);
    await t.query(`UPDATE tasks SET status='WAITING_REVIEW',review_status='PENDING',current_output_id=$2,needs_decision=false,error_code=NULL,updated_at=$3 WHERE id=$1`, [a.taskId, o.id, iso(a.now)]);
    await activity(t, a.taskId, "output.submitted", a.now, { version: v });
    await enqueueNotify(t, `notify:output:${o.id}`, { type: "OUTPUT_READY", taskCode: task.code, version: v }, a.now);
    return { output: o, alreadyProcessed: false as const, late: false as const };
  });
}

export async function acceptHumanTask(db: Db, actorRef: string, taskId: string, now: Date) {
  return db.tx(async (t) => {
    const [task] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [taskId]);
    if (!task || task.owner_kind !== "HUMAN" || task.owner_actor_ref !== actorRef) throw new LumiError("FORBIDDEN", 403);
    if (task.status === "RUNNING") return { alreadyProcessed: true };
    if (task.status !== "QUEUED") throw new LumiError("INVALID_TRANSITION", 409, { state: task.status });
    await t.query(`UPDATE tasks SET status='RUNNING',started_at=$2,updated_at=$2 WHERE id=$1`, [taskId, iso(now)]);
    return { alreadyProcessed: false };
  });
}

export async function decide(db: Db, a: { actorRef: string; outputId: string; objectVersion?: number; decision: "APPROVE" | "REVISE" | "REJECT"; reason?: string; channel: "WEB" | "TELEGRAM_APP" | "TELEGRAM_HERMES"; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (a.decision !== "APPROVE" && (a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  return db.tx(async (t) => {
    if (a.channel !== "WEB") await markTelegramAction(t);
    const [o] = await t.query<any>(`SELECT * FROM lumi_task_outputs WHERE id=$1`, [a.outputId]);
    if (!o) throw new LumiError("NOT_FOUND", 404);
    const [task] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [o.task_id]);
    if (a.objectVersion !== undefined && a.objectVersion !== o.version) throw new LumiError("STALE_VERSION", 409, { current_version: o.version });
    const prior = await t.query<any>(`SELECT * FROM lumi_approvals WHERE kind='OUTPUT' AND object_id=$1 AND object_version=$2`, [o.id, o.version]);
    if (prior[0]) {
      if (prior[0].decision === a.decision) return { approval: prior[0], alreadyProcessed: true as const };
      throw new LumiError("ALREADY_DECIDED", 409, { decision: prior[0].decision });
    }
    if (o.state !== "SUBMITTED" || task.current_output_id !== o.id || task.status !== "WAITING_REVIEW") throw new LumiError("STALE_VERSION", 409, { state: o.state, task_status: task.status });
    const [ap] = await t.query<any>(`INSERT INTO lumi_approvals (kind,object_id,object_version,decision,reason,decided_by,channel,decided_at) VALUES ('OUTPUT',$1,$2,$3,$4,$5,$6,$7) RETURNING *`, [o.id, o.version, a.decision, a.reason ?? null, a.actorRef, a.channel, iso(a.now)]);
    const map = { APPROVE: ["APPROVED", "COMPLETED", "APPROVED"], REVISE: ["REVISION_REQUESTED", "REVISION_REQUESTED", "REVISION_REQUESTED"], REJECT: ["REJECTED", "REJECTED", "REJECTED"] } as const;
    const [os, ts, rs] = map[a.decision];
    await t.query(`UPDATE lumi_task_outputs SET state=$2 WHERE id=$1`, [o.id, os]);
    await t.query(`UPDATE tasks SET status=$2::task_status,review_status=$3::task_review_status,completed_at=CASE WHEN $5::text='COMPLETED' THEN $4::timestamptz ELSE completed_at END,updated_at=$4 WHERE id=$1`, [task.id, ts, rs, iso(a.now), ts]);
    await audit(t, `approval.${a.decision.toLowerCase()}`, a.actorRef, { taskId: task.id, outputId: o.id, version: o.version, channel: a.channel }, a.now);
    await activity(t, task.id, `approval.${a.decision.toLowerCase()}`, a.now, { version: o.version, channel: a.channel });
    return { approval: ap, alreadyProcessed: false as const };
  });
}

export async function startRun(db: Db, a: { actorRef: string; taskId: string; mode: "RETRY" | "REVISION" | "REASSIGN"; expectedStatus: string; instruction?: string; forceOverLimit?: boolean; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  return db.tx(async (t) => {
    const [task] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [a.taskId]);
    if (!task) throw new LumiError("NOT_FOUND", 404);
    if (task.status !== a.expectedStatus) throw new LumiError("STALE_VERSION", 409, { status: task.status });
    const [asst] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [task.owner_assistant_id]);
    if (!asst || !asst.dispatch_enabled) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: ["dispatch_enabled"] });
    const open = await t.query(`SELECT 1 FROM lumi_task_runs WHERE task_id=$1 AND state IN ('PENDING','DISPATCHED','DISPATCH_UNCERTAIN','RUNNING')`, [a.taskId]);
    if (open.length) throw new LumiError("RUN_ACTIVE", 409);
    if (a.mode === "RETRY") {
      if (!["FAILED", "ON_HOLD"].includes(task.status)) throw new LumiError("INVALID_TRANSITION", 409, { status: task.status });
      const n = (await t.query<{ n: string }>(`SELECT count(*)::text AS n FROM lumi_task_runs WHERE task_id=$1 AND state IN ('FAILED','TIMED_OUT')`, [a.taskId]))[0]!.n;
      if (Number(n) >= asst.max_run_failures) throw new LumiError("RETRY_LIMIT", 409, { failures: Number(n), max: asst.max_run_failures });
    } else if (a.mode === "REVISION") {
      if (task.status !== "REVISION_REQUESTED") throw new LumiError("INVALID_TRANSITION", 409, { status: task.status });
      if (task.revision_round >= asst.max_revision_rounds && !a.forceOverLimit) throw new LumiError("REVISION_LIMIT", 409, { round: task.revision_round, max: asst.max_revision_rounds });
      await t.query(`UPDATE tasks SET revision_round=revision_round+1 WHERE id=$1`, [a.taskId]);
    } else {
      if (!["FAILED", "ON_HOLD", "REJECTED"].includes(task.status)) throw new LumiError("INVALID_TRANSITION", 409, { status: task.status });
      if ((a.instruction ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["instruction"] });
    }
    await createRun(t, a.taskId, asst, a.mode === "RETRY" ? "RETRY" : a.mode, a.now, { instruction: a.instruction ?? null, previousOutputId: task.current_output_id });
    await t.query(`UPDATE tasks SET status='QUEUED',error_code=NULL,error_message=NULL,needs_decision=false,updated_at=$2 WHERE id=$1`, [a.taskId, iso(a.now)]);
    await activity(t, a.taskId, `run.${a.mode.toLowerCase()}`, a.now, { by: a.actorRef });
    return { ok: true };
  });
}

export async function adoptLateOutput(db: Db, a: { actorRef: string; taskId: string; outputId: string; expectedStatus: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403); // service/bot identities can never adopt
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [task] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [a.taskId]);
    const [o] = await t.query<any>(`SELECT * FROM lumi_task_outputs WHERE id=$1 AND task_id=$2`, [a.outputId, a.taskId]);
    if (!task || !o) throw new LumiError("NOT_FOUND", 404);
    if (o.adopted_at && task.current_output_id === o.id) return { alreadyProcessed: true as const };
    if (o.state !== "LATE_SAVED") throw new LumiError("INVALID_TRANSITION", 409, { output_state: o.state });
    if (task.status !== a.expectedStatus) throw new LumiError("STALE_VERSION", 409, { status: task.status });
    if (!["FAILED", "ON_HOLD", "REJECTED"].includes(task.status)) throw new LumiError("INVALID_TRANSITION", 409, { status: task.status });
    const open = await t.query(`SELECT 1 FROM lumi_task_runs WHERE task_id=$1 AND state IN ('PENDING','DISPATCHED','DISPATCH_UNCERTAIN','RUNNING')`, [a.taskId]);
    if (open.length) throw new LumiError("RUN_ACTIVE", 409);
    if (task.current_output_id) await t.query(`UPDATE lumi_task_outputs SET state='SUPERSEDED' WHERE id=$1 AND state IN ('SUBMITTED','REJECTED')`, [task.current_output_id]);
    await t.query(`UPDATE lumi_task_outputs SET state='SUBMITTED',adopted_at=$2,adopted_by=$3 WHERE id=$1`, [o.id, iso(a.now), a.actorRef]);
    await t.query(`UPDATE tasks SET status='WAITING_REVIEW',review_status='PENDING',current_output_id=$2,error_code=NULL,updated_at=$3 WHERE id=$1`, [task.id, o.id, iso(a.now)]);
    await activity(t, task.id, "output.adopted_late", a.now, { outputId: o.id, by: a.actorRef });
    await audit(t, "output.adopted_late", a.actorRef, { taskId: task.id, outputId: o.id }, a.now);
    return { alreadyProcessed: false as const };
  });
}

export async function discardLateOutput(db: Db, actorRef: string, outputId: string) {
  if (actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, actorRef, ["OWNER"]);
  const r = await db.query(`UPDATE lumi_task_outputs SET state='DISCARDED' WHERE id=$1 AND state='LATE_SAVED' RETURNING id`, [outputId]);
  if (!r.length) throw new LumiError("INVALID_TRANSITION", 409);
}

export async function cancelTask(db: Db, actorRef: string, taskId: string, reason: string, now: Date) {
  await requireRole(db, actorRef, ["OWNER", "ADMIN"]);
  if ((reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  return db.tx(async (t) => {
    const [task] = await t.query<any>(`SELECT * FROM tasks WHERE id=$1 FOR UPDATE`, [taskId]);
    if (!task) throw new LumiError("NOT_FOUND", 404);
    if (["COMPLETED", "CANCELLED"].includes(task.status)) throw new LumiError("INVALID_TRANSITION", 409, { status: task.status });
    // The app stops waiting for the run. This does NOT prove Hermes stopped (remote_stop_state stays REQUESTED).
    const open = await t.query<any>(`UPDATE lumi_task_runs SET state='CANCELLED',finished_at=$2,remote_stop_state=CASE WHEN state='PENDING' THEN 'NONE' ELSE 'REQUESTED' END WHERE task_id=$1 AND state IN ('PENDING','DISPATCHED','DISPATCH_UNCERTAIN','RUNNING') RETURNING id,remote_stop_state`, [taskId, iso(now)]);
    for (const r of open) if (r.remote_stop_state === "REQUESTED") await enqueueStop(t, r.id, now); // a PENDING run was never sent, nothing to stop remotely
    await t.query(`UPDATE tasks SET status='CANCELLED',hold_reason=$2,needs_decision=false,updated_at=$3 WHERE id=$1`, [taskId, reason, iso(now)]);
    await activity(t, taskId, "task.cancelled", now, { by: actorRef, reason });
    await audit(t, "task.cancelled", actorRef, { taskId, reason }, now);
  });
}

export async function listOpenDrafts(db: Db, now: Date) {
  return db.query<any>(`SELECT d.id,d.raw_text,d.parsed,d.missing,d.expires_at,d.actor_ref,d.version,a.name AS assistant_name FROM lumi_intake_drafts d LEFT JOIN lumi_assistants a ON a.id=d.assistant_id WHERE d.state='OPEN' AND d.expires_at > $1 ORDER BY d.created_at DESC LIMIT 20`, [now.toISOString()]);
}

/** The person who typed a draft (or the OWNER) discards it. No task exists yet, so nothing else changes. */
export async function cancelDraft(db: Db, actorRef: string, draftId: string, now: Date) {
  return db.tx(async (t) => {
    const [d] = await t.query<any>(`SELECT * FROM lumi_intake_drafts WHERE id=$1 FOR UPDATE`, [draftId]);
    if (!d) throw new LumiError("NOT_FOUND", 404);
    await draftAccess(t, d, actorRef);
    if (d.state === "CANCELLED") return { alreadyProcessed: true as const };
    if (d.state !== "OPEN") throw new LumiError("INVALID_TRANSITION", 409, { state: d.state });
    await t.query(`UPDATE lumi_intake_drafts SET state='CANCELLED',updated_at=$2 WHERE id=$1`, [draftId, now.toISOString()]);
    await audit(t, "intake.cancelled", actorRef, { draftId: "" }, now);
    return { alreadyProcessed: false as const };
  });
}

/** Same as upsertActor (core-web) but exported from core so the Lumi UI adapter needs one import. */
export async function upsertActorRef(db: Db, actorRef: string, role: Role, channel = "WEB") {
  await db.query(`INSERT INTO lumi_actors(actor_ref,role,channel) VALUES ($1,$2,$3) ON CONFLICT (actor_ref) DO UPDATE SET role=EXCLUDED.role`, [actorRef, role, channel]);
}
