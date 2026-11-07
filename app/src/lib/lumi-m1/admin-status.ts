/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-02 / ADM-01, ADM-05, ADM-07, ADM-08: everything the Admin screen shows is something this process OBSERVED (a database row, a file on disk, a worker
 * snapshot with its age). Nothing here is invented; where nothing was observed the field is null and the UI says "chưa có".
 */
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./core";
import type { HermesSnapshot, NotificationRow, WorkerStatus } from "../lumi/admin";

const flagValue = async (db: Db, key: string): Promise<{ value: any; set_at: string } | null> => (await db.query<any>(`SELECT value,set_at FROM lumi_system_flags WHERE key=$1`, [key]))[0] ?? null;

export async function markNotificationsSeen(db: Db, actorRef: string, now: Date) {
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,set_by=EXCLUDED.set_by,set_at=EXCLUDED.set_at`,
    [`notif_seen:${actorRef}`, JSON.stringify({ at: now.toISOString() }), actorRef, now.toISOString()]);
}

/** Notification inbox: the in-app view of the events that are ALSO queued for Telegram (so nothing depends on the Telegram channel being connected). */
export async function listNotifications(db: Db, actorRef: string) {
  const rows = await db.query<any>(`SELECT id,payload,state,last_error,created_at FROM lumi_outbox WHERE kind='TELEGRAM_NOTIFY' ORDER BY created_at DESC LIMIT 50`);
  const planCodes = [...new Set(rows.map((r: any) => r.payload?.planCode).filter(Boolean))] as string[];
  const taskCodes = [...new Set(rows.map((r: any) => r.payload?.taskCode).filter(Boolean))] as string[];
  const plans = planCodes.length ? await db.query<any>(`SELECT code,id FROM lumi_plans WHERE code = ANY($1::text[])`, [planCodes]) : [];
  const tasks = taskCodes.length ? await db.query<any>(`SELECT t.code,p.slug FROM tasks t JOIN lumi_projects p ON p.id=t.project_id WHERE t.code = ANY($1::text[])`, [taskCodes]) : [];
  const planId = new Map(plans.map((p: any) => [p.code, p.id])); const taskSlug = new Map(tasks.map((t: any) => [t.code, t.slug]));
  const out: NotificationRow[] = rows.map((r: any) => {
    const pl = r.payload ?? {};
    const href = pl.planCode && planId.get(pl.planCode) ? `/lumi/plans/${planId.get(pl.planCode)}` : pl.taskCode && taskSlug.get(pl.taskCode) ? `/lumi/projects/${taskSlug.get(pl.taskCode)}?task=${pl.taskCode}` : null;
    return { id: r.id, type: String(pl.type ?? "?"), created_at: new Date(r.created_at).toISOString(), state: r.state, last_error: r.last_error, planCode: pl.planCode, taskCode: pl.taskCode, version: pl.version, status: pl.status, href };
  });
  const seen = await flagValue(db, `notif_seen:${actorRef}`);
  const seenAt = seen?.value?.at ?? null;
  return { rows: out, seen_at: seenAt, unread: out.filter((r) => !seenAt || Date.parse(r.created_at) > Date.parse(seenAt)).length };
}

export async function unreadNotifications(db: Db, actorRef: string): Promise<number> {
  const seen = await flagValue(db, `notif_seen:${actorRef}`);
  const at = seen?.value?.at ?? "1970-01-01T00:00:00Z";
  const [r] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM lumi_outbox WHERE kind='TELEGRAM_NOTIFY' AND created_at > $1::timestamptz`, [at]);
  return r!.n;
}

/** Latest backup files in the configured directory (read-only). Restore drills are NOT recorded anywhere yet, and the screen says so. */
export function readBackups(dir: string): { readable: boolean; latest: { name: string; size: number; mtime: string }[] } {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".dump")).map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, size: st.size, mtime: st.mtime.toISOString() }; });
    files.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
    return { readable: true, latest: files.slice(0, 5) };
  } catch { return { readable: false, latest: [] }; } // the server path is deliberately not part of the response
}

export async function buildAdminStatus(db: Db, o: { actorRef: string; role: string; pingHermes?: () => Promise<any>; backupDir?: string; now: Date }) {
  const wf = await db.query<any>(`SELECT key,value,set_at FROM lumi_system_flags WHERE key LIKE 'worker_status:%' ORDER BY key`);
  const workers = wf.map((r: any) => ({ lane: String(r.key).slice("worker_status:".length), status: r.value as WorkerStatus }));
  const snap = await flagValue(db, "hermes_status");
  const [wp] = await db.query<any>(`SELECT state,updated_at,last_error_code,last_error_message FROM wordpress_sync_jobs ORDER BY updated_at DESC LIMIT 1`).catch(() => []);
  const pub = o.pingHermes ? await o.pingHermes().catch(() => null) : null;
  return {
    now: o.now.toISOString(), role: o.role,
    workers,
    hermes: { snapshot: (snap?.value ?? null) as HermesSnapshot | null, public: pub },
    telegram: { hermesBot: process.env.LUMI_TELEGRAM_BOT ?? null, appWebhookConfigured: !!process.env.TELEGRAM_WEBHOOK_SECRET },
    wordpress: { configured: !!process.env.WORDPRESS_BASE_URL, last_sync: wp ? { state: wp.state, updated_at: new Date(wp.updated_at).toISOString(), error: wp.last_error_code ? `${wp.last_error_code}: ${wp.last_error_message ?? ""}` : null } : null },
    backups: readBackups(o.backupDir ?? process.env.LUMI_BACKUP_DIR ?? "/home/opssite/backups"),
    restore_drill: null as null | { at: string; result: string },
    notifications: await listNotifications(db, o.actorRef),
  };
}
