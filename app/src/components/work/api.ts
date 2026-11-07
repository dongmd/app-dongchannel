"use client";
/** Calls the M1 HTTP contract (TDD 8.6/8.7) from the browser. Same-origin cookies; JSON only (the server rejects other types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are shaped by the endpoint; callers read the fields they need
export interface ApiResult { ok: boolean; status: number; data: any; error: { code: string; message: string; details?: any } | null }
export async function api(method: string, url: string, body?: unknown, idempotencyKey?: string): Promise<ApiResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  const j = await res.json().catch(() => ({ data: null, error: { code: "BAD_RESPONSE", message: "Phản hồi không hợp lệ" } }));
  return { ok: res.ok, status: res.status, data: j.data, error: j.error ?? null };
}
export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
export function explain(r: ApiResult): string {
  if (r.ok) return "";
  const d = r.error?.details?.missing ? ` (thiếu: ${[].concat(r.error.details.missing).join(", ")})` : r.error?.details?.extra ? ` (${[].concat(r.error.details.extra).join(", ")})` : "";
  return `${r.error?.message ?? "Lỗi"} [${r.error?.code ?? r.status}]${d}`;
}
