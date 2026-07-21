// Backend-only Hermes REST client.
// Tuân nguyên tắc kiến trúc #6: chỉ backend Next.js được phép gọi Hermes API.
// Tuân nguyên tắc kiến trúc #7: HERMES_BASIC_PASSWORD không xuất hiện trong bundle client.
//
// Auth: Hermes hiện dùng basic auth interim (chưa có Nous Portal OAuth).
// Cùng credential dùng cho human dashboard + service — chấp nhận trong V1.
// Discovery: xem docs/dashboard-discovery.md mục 3.

import "server-only";

export interface HermesConfig {
  baseUrl: string;
  basicAuth: string | undefined;
  timeoutMs: number;
}

function encodeBasicAuth(user: string | undefined, password: string | undefined): string | undefined {
  if (!user || !password) return undefined;
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

function getConfig(): HermesConfig {
  const baseUrl = process.env.HERMES_API_BASE_URL;
  if (!baseUrl) throw new Error("HERMES_API_BASE_URL is not set");
  return {
    baseUrl,
    basicAuth: encodeBasicAuth(process.env.HERMES_BASIC_USER, process.env.HERMES_BASIC_PASSWORD),
    timeoutMs: 15_000,
  };
}

export class HermesUpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "HermesUpstreamError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(new URL(path, cfg.baseUrl), {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(cfg.basicAuth ? { Authorization: cfg.basicAuth } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new HermesUpstreamError(res.status, body, `Hermes ${path} → ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// Endpoints đã confirm qua SSH probe 2026-07-21:
//   /api/status       → 200 (public, no auth needed)
//   /api/health       → 401 (needs basic auth)
//   /api/sessions     → 401 (needs basic auth)
//   /api/openapi.json → 401 (needs basic auth — chưa fetch được contract đầy đủ)
//
// Contract chi tiết sẽ hoàn thiện ở DC-006 sau khi lấy OpenAPI spec.
export const hermes = {
  publicStatus: () => request<unknown>("/api/status"),
  health: () => request<unknown>("/api/health"),
  listSessions: (params?: { profile?: string; cursor?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.profile) qs.set("profile", params.profile);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<unknown>(`/api/sessions${suffix}`);
  },
  // ... mở rộng ở DC-006
};
