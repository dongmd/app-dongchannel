import "server-only";
import { and, count, desc, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks, type TaskStatus } from "@/lib/db/schema/tasks";
import type { ProfileFilter } from "@/lib/profiles/types";
import { pingHermesStatus, type HermesStatus } from "@/lib/hermes/status";

// Aggregator cho `/api/v1/dashboard/summary` (PRD FR-01).
// V1: query thật từ tasks table (DC-006 đã ingest sessions → tasks).
// Memory/decisions vẫn 0 (DC-010).

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
  createdAt: string;
  href: string;
}

export interface ActiveTaskItem {
  id: string;
  code: string;
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

// Scope filter cho query — 'all' = 2 bot profile (aff+yt), không bao gồm default (system).
function profileScope(profile: ProfileFilter): ("aff" | "yt")[] {
  if (profile === "aff") return ["aff"];
  if (profile === "yt") return ["yt"];
  return ["aff", "yt"];
}

function narrowProfile(slug: string): "aff" | "yt" {
  return slug === "aff" || slug === "yt" ? slug : "aff";
}

const PENDING_REVIEW: TaskStatus[] = ["WAITING_REVIEW"];
const RUNNING: TaskStatus[] = ["RUNNING", "QUEUED"];
const ALERTS: TaskStatus[] = ["FAILED", "SYNC_DELAYED"];

async function queryKpi(scope: ("aff" | "yt")[]): Promise<KpiCounts> {
  const [pendingReviewRow, runningRow, alertsRow] = await Promise.all([
    db
      .select({ n: count() })
      .from(tasks)
      .where(and(inArray(tasks.profileSlug, scope), inArray(tasks.status, PENDING_REVIEW))),
    db
      .select({ n: count() })
      .from(tasks)
      .where(and(inArray(tasks.profileSlug, scope), inArray(tasks.status, RUNNING))),
    db
      .select({ n: count() })
      .from(tasks)
      .where(and(inArray(tasks.profileSlug, scope), inArray(tasks.status, ALERTS))),
  ]);
  return {
    pendingReview: pendingReviewRow[0]?.n ?? 0,
    running: runningRow[0]?.n ?? 0,
    alerts: alertsRow[0]?.n ?? 0,
    activeTests: 0, // AFF offers.status=TESTING + YT videos.status=PUBLISHED — chờ DC-011/012
  };
}

async function queryDecisionInbox(scope: ("aff" | "yt")[]): Promise<DecisionInboxItem[]> {
  const rows = await db
    .select({
      id: tasks.id,
      code: tasks.code,
      title: tasks.title,
      profileSlug: tasks.profileSlug,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(inArray(tasks.profileSlug, scope), inArray(tasks.status, PENDING_REVIEW)))
    .orderBy(desc(tasks.updatedAt))
    .limit(10);
  return rows.map((r) => ({
    id: r.id,
    type: "task_review" as const,
    title: `${r.code} · ${r.title}`,
    profile: narrowProfile(r.profileSlug),
    priority: "normal" as const,
    createdAt: r.updatedAt.toISOString(),
    href: `/tasks/${r.id}`,
  }));
}

async function queryActiveTasks(scope: ("aff" | "yt")[]): Promise<ActiveTaskItem[]> {
  const rows = await db
    .select({
      id: tasks.id,
      code: tasks.code,
      title: tasks.title,
      profileSlug: tasks.profileSlug,
      status: tasks.status,
      startedAt: tasks.startedAt,
    })
    .from(tasks)
    .where(and(inArray(tasks.profileSlug, scope), inArray(tasks.status, RUNNING)))
    .orderBy(desc(tasks.startedAt))
    .limit(10);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    profile: narrowProfile(r.profileSlug),
    status: r.status === "QUEUED" ? "queued" : "running",
    startedAt: r.startedAt?.toISOString(),
    href: `/tasks/${r.id}`,
  }));
}

async function queryRecentResults(scope: ("aff" | "yt")[]): Promise<RecentResultItem[]> {
  const rows = await db
    .select({
      id: tasks.id,
      code: tasks.code,
      title: tasks.title,
      profileSlug: tasks.profileSlug,
      completedAt: tasks.completedAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.profileSlug, scope),
        inArray(tasks.status, ["COMPLETED", "APPROVED", "IMPORTED"] as TaskStatus[]),
      ),
    )
    .orderBy(desc(sql`COALESCE(${tasks.completedAt}, ${tasks.updatedAt})`))
    .limit(5);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    profile: narrowProfile(r.profileSlug),
    completedAt: (r.completedAt ?? r.updatedAt).toISOString(),
    href: `/tasks/${r.id}`,
  }));
}

function computeNextBestActions(input: {
  profile: ProfileFilter;
  hermes: HermesStatus;
  totalTasks: number;
  pendingReview: number;
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
  if (input.pendingReview > 0) {
    actions.push({
      id: "review-tasks",
      title: `Duyệt ${input.pendingReview} nhiệm vụ chờ`,
      reason: "Ưu tiên cao — người dùng đang chờ quyết định.",
      href: "/tasks?status=WAITING_REVIEW",
    });
  }
  if (input.totalTasks === 0) {
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
    actions.push({
      id: "trigger-ingest",
      title: "Chạy ingest thủ công",
      reason: "Nếu bot đã có session mà chưa lên dashboard, thử pull từ Hermes.",
      href: "/admin",
    });
  }
  return actions.slice(0, 5);
}

export async function computeDashboardSummary(profile: ProfileFilter): Promise<DashboardSummary> {
  const now = Date.now();
  const cache = getCache();
  const cached = cache.get(profile);
  if (cached && cached.expiresAt > now) return cached.value;

  const scope = profileScope(profile);
  const [kpi, decisionInbox, activeTasks, recentResults, hermes, totalTasksRow] = await Promise.all([
    queryKpi(scope),
    queryDecisionInbox(scope),
    queryActiveTasks(scope),
    queryRecentResults(scope),
    pingHermesStatus(),
    db.select({ n: count() }).from(tasks).where(inArray(tasks.profileSlug, scope)),
  ]);

  const totalTasks = totalTasksRow[0]?.n ?? 0;

  const value: DashboardSummary = {
    profile,
    kpi,
    decisionInbox,
    activeTasks,
    recentResults,
    nextBestActions: computeNextBestActions({
      profile,
      hermes,
      totalTasks,
      pendingReview: kpi.pendingReview,
    }),
    hermes,
    generatedAt: new Date().toISOString(),
  };

  cache.set(profile, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
