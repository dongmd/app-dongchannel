import "server-only";
import type { ProfileFilter } from "@/lib/profiles/types";
import { pingHermesStatus, type HermesStatus } from "@/lib/hermes/status";

// Aggregator cho `/api/v1/dashboard/summary` (PRD FR-01).
// V1: task/memory/decision counts = 0 vì tables tương ứng chưa có (DC-006 = tasks,
// DC-010 = memory). Structure sẵn để DC-006 chỉ cần điền query, không đụng UI/route.
//
// Cache 30s giống Hermes status — Overview page load nhiều, không cần realtime.

export interface KpiCounts {
  pendingReview: number;
  running: number;
  alerts: number;
  activeTests: number;
}

export interface DecisionInboxItem {
  id: string;
  type: "task_review" | "memory_proposal";
  title: string;
  profile: "aff" | "yt";
  priority: "high" | "normal" | "low";
  createdAt: string; // ISO
  href: string;
}

export interface ActiveTaskItem {
  id: string;
  code: string; // AFF-0014
  title: string;
  profile: "aff" | "yt";
  status: "queued" | "running";
  currentStep?: string;
  startedAt?: string;
  href: string;
}

export interface RecentResultItem {
  id: string;
  code: string;
  title: string;
  profile: "aff" | "yt";
  completedAt: string;
  href: string;
}

export interface NextBestAction {
  id: string;
  title: string;
  reason: string;
  href: string;
}

export interface DashboardSummary {
  profile: ProfileFilter;
  kpi: KpiCounts;
  decisionInbox: DecisionInboxItem[];
  activeTasks: ActiveTaskItem[];
  recentResults: RecentResultItem[];
  nextBestActions: NextBestAction[];
  hermes: HermesStatus;
  generatedAt: string;
}

// Cache: 1 entry per profile filter (max 3: all/aff/yt).
interface CacheEntry {
  value: DashboardSummary;
  expiresAt: number;
}
const CACHE_TTL_MS = 30_000;
const globalForCache = globalThis as unknown as {
  __dashboardSummaryCache: Map<ProfileFilter, CacheEntry> | undefined;
};
function getCache(): Map<ProfileFilter, CacheEntry> {
  if (!globalForCache.__dashboardSummaryCache) {
    globalForCache.__dashboardSummaryCache = new Map();
  }
  return globalForCache.__dashboardSummaryCache;
}

// V1 rule-based Next Best Actions (PRD FR-01):
// - Nếu Hermes impaired/down → hành động đầu tiên là "Kiểm tra hạ tầng"
// - Nếu chưa có task nào → gợi ý gửi mission qua Telegram
// - Còn lại reserved cho DC-006/010 (khi có decision inbox non-empty)
function computeNextBestActions(input: {
  profile: ProfileFilter;
  hermes: HermesStatus;
  hasAnyTask: boolean;
}): NextBestAction[] {
  const actions: NextBestAction[] = [];
  if (input.hermes.level !== "ok") {
    actions.push({
      id: "check-hermes",
      title: "Kiểm tra kết nối Hermes",
      reason: `Gateway đang ${input.hermes.level === "down" ? "mất kết nối" : "gián đoạn"}.`,
      href: "/admin",
    });
  }
  if (!input.hasAnyTask) {
    const botHint =
      input.profile === "aff"
        ? "AFF Bot (@hermes_dongmd_bot)"
        : input.profile === "yt"
          ? "YouTube Bot (@my_hermes_agent_ytb_bot)"
          : "AFF Bot hoặc YouTube Bot";
    actions.push({
      id: "send-mission",
      title: `Gửi mission cho ${botHint}`,
      reason: "Chưa có nhiệm vụ nào — Telegram là kênh giao việc chính (V1).",
      href: "https://t.me/hermes_dongmd_bot",
    });
  }
  return actions.slice(0, 5); // AC PRD FR-01
}

export async function computeDashboardSummary(
  profile: ProfileFilter,
): Promise<DashboardSummary> {
  const now = Date.now();
  const cache = getCache();
  const cached = cache.get(profile);
  if (cached && cached.expiresAt > now) return cached.value;

  // V1 — chưa có tables tasks/memory. DC-006/010 sẽ thay các số 0 bằng query thật:
  //   SELECT count(*) FROM tasks WHERE review_status = 'WAITING_REVIEW' AND (profile_id filter)
  //   SELECT count(*) FROM tasks WHERE status IN ('QUEUED','RUNNING') AND ...
  //   SELECT count(*) FROM tasks WHERE status = 'FAILED' OR review_status = 'SYNC_DELAYED' ...
  //   SELECT count(*) FROM offers WHERE status = 'TESTING' (AFF) + videos WHERE status = 'PUBLISHED' (YT)
  const kpi: KpiCounts = {
    pendingReview: 0,
    running: 0,
    alerts: 0,
    activeTests: 0,
  };

  const hermes = await pingHermesStatus();

  const value: DashboardSummary = {
    profile,
    kpi,
    decisionInbox: [],
    activeTasks: [],
    recentResults: [],
    nextBestActions: computeNextBestActions({ profile, hermes, hasAnyTask: false }),
    hermes,
    generatedAt: new Date().toISOString(),
  };

  cache.set(profile, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
