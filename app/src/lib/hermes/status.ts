import "server-only";

// Public health check của Hermes (`/api/status` — 200 no-auth, confirmed Discovery Gate mục 2).
// Body thực tế (SSH probe 2026-07-21) gồm: version, gateway_running, gateway_state, active_agents,
// active_sessions, profiles[], gateway_mode, auth_providers, ...
// Cache 30s + in-flight dedup để tránh stampede khi nhiều tab poll đồng thời.

export type HermesHealthLevel = "ok" | "impaired" | "down";

export interface HermesStatus {
  level: HermesHealthLevel;
  gatewayRunning?: boolean;
  gatewayState?: string;
  version?: string;
  releaseDate?: string;
  activeSessions?: number;
  activeAgents?: number;
  profiles?: string[];
  ms?: number;
  error?: string;
  checkedAt: string; // ISO
}

interface CacheEntry {
  value: HermesStatus;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const TIMEOUT_MS = 3_000;

const globalForCache = globalThis as unknown as {
  __hermesStatusCache: CacheEntry | undefined;
  __hermesStatusInFlight: Promise<HermesStatus> | undefined;
};

function getBaseUrl(): string | null {
  const url = process.env.HERMES_API_BASE_URL;
  return url && url.trim() ? url : null;
}

async function doPing(): Promise<HermesStatus> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    return {
      level: "down",
      error: "Chưa cấu hình kết nối tới Hermes — kiểm tra biến môi trường trên server.",
      checkedAt: new Date().toISOString(),
    };
  }

  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(new URL("/api/status", baseUrl), {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const ms = Math.round(performance.now() - start);

    if (!res.ok) {
      return {
        level: "down",
        ms,
        error: `Hermes /api/status → HTTP ${res.status}`,
        checkedAt: new Date().toISOString(),
      };
    }

    // Parse body — safe nếu Hermes đổi format sau này (level không rely vào từng field cụ thể).
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // response không phải JSON — mark impaired
      return {
        level: "impaired",
        ms,
        error: "Hermes trả body không hợp lệ.",
        checkedAt: new Date().toISOString(),
      };
    }

    const gatewayRunning = typeof body["gateway_running"] === "boolean"
      ? (body["gateway_running"] as boolean)
      : undefined;
    const gatewayState =
      typeof body["gateway_state"] === "string" ? (body["gateway_state"] as string) : undefined;

    // BR10 (TDD mục 11) — level phải map rõ từ trạng thái Hermes, không suy đoán từ latency.
    //   gateway_running === true                       → ok
    //   HTTP 200 nhưng gateway not running/unknown      → impaired
    //   fetch fail / HTTP lỗi                            → down (xử lý ở catch/branch trên)
    const level: HermesHealthLevel = gatewayRunning === true ? "ok" : "impaired";

    return {
      level,
      gatewayRunning,
      gatewayState,
      version: typeof body["version"] === "string" ? (body["version"] as string) : undefined,
      releaseDate:
        typeof body["release_date"] === "string" ? (body["release_date"] as string) : undefined,
      activeAgents:
        typeof body["active_agents"] === "number" ? (body["active_agents"] as number) : undefined,
      activeSessions:
        typeof body["active_sessions"] === "number"
          ? (body["active_sessions"] as number)
          : undefined,
      profiles: Array.isArray(body["profiles"])
        ? (body["profiles"] as unknown[]).filter((p): p is string => typeof p === "string")
        : undefined,
      ms,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timeout sau ${TIMEOUT_MS}ms`
          : err.message
        : "Lỗi không xác định";
    return {
      level: "down",
      ms,
      error: message,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function pingHermesStatus(force = false): Promise<HermesStatus> {
  const now = Date.now();
  const cached = globalForCache.__hermesStatusCache;
  if (!force && cached && cached.expiresAt > now) return cached.value;

  // In-flight dedup — cùng cache-miss window chỉ 1 fetch thực chạy, các caller còn lại chờ chung.
  if (globalForCache.__hermesStatusInFlight) {
    return globalForCache.__hermesStatusInFlight;
  }

  const inFlight = doPing()
    .then((value) => {
      globalForCache.__hermesStatusCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      globalForCache.__hermesStatusInFlight = undefined;
    });

  globalForCache.__hermesStatusInFlight = inFlight;
  return inFlight;
}
