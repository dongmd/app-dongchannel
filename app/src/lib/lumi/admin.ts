/**
 * IMP-02 / ADM-01, ADM-07, ADM-08 — pure helpers for the Admin screen. A card never shows "OK" it did not observe: a snapshot older than the
 * monitoring interval is "mất tín hiệu", and an absent snapshot is "chưa có dữ liệu" — never a made-up "Đồng bộ lúc …".
 */
export type Level = "ok" | "warn" | "down" | "unknown";

/** Monitoring interval, NOT a business policy: the worker writes a snapshot about every 60 s; three missed beats = signal lost. */
export const SNAPSHOT_STALE_SECONDS = 180;

export const ageSeconds = (iso: string | null | undefined, nowMs: number): number | null => (iso ? Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000)) : null);
export function ageText(iso: string | null | undefined, nowMs: number): string {
  const s = ageSeconds(iso, nowMs);
  if (s === null) return "chưa có";
  if (s < 90) return `${s} giây trước`;
  if (s < 5400) return `${Math.round(s / 60)} phút trước`;
  if (s < 172800) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}

export interface WorkerStatus { at: string; mode: string; serves: string[]; pid?: number; lastError?: string | null }
export function workerCard(st: WorkerStatus | null, nowMs: number): { level: Level; text: string } {
  if (!st) return { level: "unknown", text: "Chưa có tín hiệu từ worker này (chưa chạy hoặc chưa ghi lần nào)." };
  const age = ageSeconds(st.at, nowMs)!;
  if (age > SNAPSHOT_STALE_SECONDS) return { level: "down", text: `Mất tín hiệu: lần cuối ${ageText(st.at, nowMs)}.` };
  if (st.lastError) return { level: "warn", text: `Đang chạy nhưng có lỗi gần nhất: ${st.lastError}` };
  return { level: "ok", text: `Đang chạy (tín hiệu ${ageText(st.at, nowMs)}).` };
}

export interface CronJobStatus { name: string; enabled: boolean; last_run_at: string | null; last_status: string | null; last_error: string | null; next_run_at: string | null }
export interface ProfileStatus { profile: string; gateway: string | null; telegram: string | null; cron: CronJobStatus[] }
export interface HermesSnapshot { at: string; profiles: ProfileStatus[] }

export function profileCard(p: ProfileStatus, snapshotAt: string | null, nowMs: number): { level: Level; lines: string[] } {
  const age = ageSeconds(snapshotAt, nowMs);
  if (age === null) return { level: "unknown", lines: ["Chưa có dữ liệu trạng thái từ Hermes."] };
  if (age > SNAPSHOT_STALE_SECONDS) return { level: "down", lines: [`Mất kết nối tới Hermes: dữ liệu cuối ${ageText(snapshotAt, nowMs)} (không hiển thị trạng thái cũ như hiện tại).`] };
  const lines: string[] = [];
  let level: Level = "ok";
  if (p.gateway === null) lines.push("Không có gateway (không nhận Telegram) — bình thường với profile chỉ chạy lượt từ ứng dụng.");
  else { lines.push(`Gateway: ${p.gateway === "running" ? "đang chạy" : `KHÔNG chạy (${p.gateway})`}`); if (p.gateway !== "running") level = "down"; }
  if (p.gateway !== null) { lines.push(`Telegram: ${p.telegram === "connected" ? "đã kết nối" : `KHÔNG kết nối (${p.telegram ?? "không rõ"})`}`); if (p.telegram !== "connected" && level === "ok") level = "warn"; }
  for (const j of p.cron) {
    const bad = !j.enabled ? "đã tắt" : j.last_status && j.last_status !== "ok" ? `lỗi: ${j.last_error ?? j.last_status}` : null;
    lines.push(`Cron «${j.name}»: ${bad ?? `lần chạy gần nhất ${ageText(j.last_run_at, nowMs)}, kết quả ${j.last_status ?? "chưa có"}`}`);
    if (bad && level === "ok") level = "warn";
  }
  if (p.cron.length === 0 && p.gateway !== null) lines.push("Cron: không có job.");
  return { level, lines };
}

export interface NotificationRow { id: string; type: string; created_at: string; state: string; last_error: string | null; planCode?: string; taskCode?: string; version?: number; status?: string; href: string | null }
const TYPE_TEXT: Record<string, (r: NotificationRow) => string> = {
  PLAN_READY: (r) => `Kế hoạch ${r.planCode ?? ""} (phiên bản ${r.version ?? "?"}) đã sẵn sàng để bạn duyệt`,
  PLAN_DONE: (r) => `Kế hoạch ${r.planCode ?? ""} đã kết thúc (${r.status ?? "?"}); mục tiêu chờ bạn đóng`,
  PLAN_PAUSED: (r) => `Kế hoạch ${r.planCode ?? ""} tạm dừng chờ điều chỉnh ngân sách`,
  OUTPUT_READY: (r) => `Việc ${r.taskCode ?? ""} có đầu ra (bản ${r.version ?? "?"}) chờ bạn duyệt`,
};
export function describeNotification(r: NotificationRow): { text: string; delivery: string } {
  const text = (TYPE_TEXT[r.type] ?? (() => `Sự kiện ${r.type}`))(r);
  const delivery = r.state === "DEAD" ? "gửi Telegram lỗi" : r.last_error?.startsWith("NOT_DELIVERED") ? "chưa gửi Telegram (kênh chưa nối) — xem ở đây" : r.state === "DONE" ? "đã gửi Telegram" : "đang chờ gửi";
  return { text, delivery };
}
