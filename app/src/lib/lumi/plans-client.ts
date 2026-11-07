/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/** Client helpers for the IMP-01 screens (company, plan). Talks to /api/v1/lumi/* with the signed-in session. */
export interface ApiResult<T = any> { ok: boolean; status: number; data: T | null; error: { code: string; message: string; details?: any } | null }

export async function lumiApi<T = any>(path: string, o: { method?: "GET" | "POST" | "PATCH"; body?: unknown; key?: string } = {}): Promise<ApiResult<T>> {
  try {
    const method = o.method ?? "GET";
    const res = await fetch(path, {
      method, credentials: "same-origin", cache: "no-store",
      headers: { ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) },
      ...(method !== "GET" ? { body: JSON.stringify(o.body ?? {}) } : {}),
    });
    const j = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data: j?.data ?? null, error: j?.error ?? (res.ok ? null : { code: "HTTP_" + res.status, message: "Lỗi " + res.status }) };
  } catch {
    return { ok: false, status: 0, data: null, error: { code: "NETWORK", message: "Không kết nối được máy chủ" } };
  }
}
export const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** One readable sentence for an API error, including which fields are missing. */
export function errText(e: ApiResult["error"]): string {
  if (!e) return "Lỗi không xác định";
  const d = e.details;
  const extra = d?.errors ? ` — ${(d.errors as string[]).slice(0, 6).join("; ")}` : d?.missing ? ` — thiếu/sai: ${(d.missing as string[]).join(", ")}` : d && Object.keys(d).length ? ` — ${JSON.stringify(d).slice(0, 160)}` : "";
  return `${e.message}${extra}`;
}

export const PLAN_STATUS_LABEL: Record<string, string> = {
  DRAFTING: "Bot đang lập", PENDING_APPROVAL: "Chờ Chủ duyệt", NEEDS_REVISION: "Cần sửa", DEFERRED: "Đã hoãn", REJECTED: "Đã từ chối", EXECUTING: "Đang thực hiện",
  PAUSED_ADJUSTMENT: "Tạm dừng chờ điều chỉnh ngân sách", PARTIAL_DONE: "Hoàn tất một phần", DONE: "Kế hoạch hoàn tất", CANCELLED: "Đã hủy",
};
export const PLAN_TONE: Record<string, string> = { DRAFTING: "blue", PENDING_APPROVAL: "amber", NEEDS_REVISION: "amber", DEFERRED: "", REJECTED: "", EXECUTING: "purple", PAUSED_ADJUSTMENT: "amber", PARTIAL_DONE: "green", DONE: "green", CANCELLED: "" };
export const VERSION_LABEL: Record<string, string> = { SUBMITTED: "Chờ duyệt", APPROVED: "Đã duyệt", REJECTED: "Không duyệt", SUPERSEDED: "Đã được thay", EXPIRED: "Hết hạn" };
export const GOAL_RESULT_LABEL: Record<string, string> = { ACHIEVED: "Đạt", NOT_ACHIEVED: "Không đạt", INSUFFICIENT_DATA: "Chưa đủ dữ liệu", ABANDONED: "Bỏ" };
export const TASK_STATUS_LABEL: Record<string, string> = {
  QUEUED: "Sẵn sàng", RUNNING: "Đang làm", WAITING_REVIEW: "Chờ Chủ duyệt đầu ra", REVISION_REQUESTED: "Cần sửa", COMPLETED: "Hoàn tất", FAILED: "Lỗi", ON_HOLD: "Tạm dừng",
  CANCELLED: "Đã hủy", WAITING_ASSISTANT: "Chờ kết nối trợ lý", REJECTED: "Bị từ chối", CAPTURED: "Chờ",
};
export const CATEGORY_LABEL: Record<string, string> = { AI: "AI/API", TOOL: "Công cụ", ADS: "Quảng cáo", PRODUCTION: "Sản xuất", ASSET: "Tài sản", OUTSOURCE: "Thuê ngoài", FEE: "Phí", COORD: "Điều phối", SHARED: "Chi chung", OTHER: "Khác" };
export const SOURCE_LABEL: Record<string, string> = { ESTIMATED: "ước tính", MEASURED: "đo được", BOT_DECLARED: "bot khai", PROVIDER_STATEMENT: "sao kê nhà cung cấp", MANUAL: "Chủ nhập tay", UNKNOWN: "chưa biết" };

/** `null` is "chưa biết", never 0. */
export function fmtMoney(n: number | string | null | undefined, cur?: string | null): string {
  if (n === null || n === undefined) return "chưa biết";
  const v = Number(n);
  return `${v.toLocaleString("vi-VN", { maximumFractionDigits: 6 })}${cur ? ` ${cur}` : ""}`;
}
