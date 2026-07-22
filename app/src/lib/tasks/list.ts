import "server-only";
import { and, desc, eq, ilike, inArray, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks, type TaskStatus } from "@/lib/db/schema/tasks";
import { hermesSessions } from "@/lib/db/schema/hermes";
import type { ProfileFilter } from "@/lib/profiles/types";

// AC01/AC02/AC03/AC05 — filter + search + cursor pagination.
// Cursor = updated_at::iso + '__' + id (stable + unique tie-breaker).

export type StatusGroup = "all" | "pending_review" | "running" | "alerts" | "completed";

const STATUS_MAP: Record<StatusGroup, TaskStatus[] | null> = {
  all: null,
  pending_review: ["WAITING_REVIEW"],
  running: ["RUNNING", "QUEUED"],
  alerts: ["FAILED", "SYNC_DELAYED"],
  completed: ["COMPLETED", "APPROVED", "IMPORTED"],
};

export interface TaskListItem {
  id: string;
  code: string;
  profileSlug: "aff" | "yt";
  title: string;
  status: TaskStatus;
  reviewStatus: string;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  source: string | null;
  messageCount: number | null;
}

export interface ListTasksInput {
  profile: ProfileFilter;
  status?: StatusGroup;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface ListTasksResult {
  items: TaskListItem[];
  nextCursor: string | null;
  totalMatched?: number;
}

function profileScope(profile: ProfileFilter): ("aff" | "yt")[] {
  if (profile === "aff") return ["aff"];
  if (profile === "yt") return ["yt"];
  return ["aff", "yt"];
}

function decodeCursor(cursor: string | undefined): { updatedAt: Date; id: string } | null {
  if (!cursor) return null;
  const parts = cursor.split("__");
  if (parts.length !== 2) return null;
  const [iso, id] = parts;
  if (!iso || !id) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { updatedAt: d, id };
}

function encodeCursor(row: { updatedAt: Date; id: string }): string {
  return `${row.updatedAt.toISOString()}__${row.id}`;
}

function narrowProfile(slug: string): "aff" | "yt" {
  return slug === "aff" || slug === "yt" ? slug : "aff";
}

export async function listTasks(input: ListTasksInput): Promise<ListTasksResult> {
  const scope = profileScope(input.profile);
  const statusGroup = input.status ?? "all";
  const statuses = STATUS_MAP[statusGroup];
  const limit = Math.min(input.limit ?? 20, 100);
  const cursor = decodeCursor(input.cursor);

  const whereClauses = [inArray(tasks.profileSlug, scope)];
  if (statuses) whereClauses.push(inArray(tasks.status, statuses));
  if (input.q && input.q.trim().length > 0) {
    whereClauses.push(ilike(tasks.title, `%${input.q.trim()}%`));
  }
  if (cursor) {
    // (updated_at < cursor.updatedAt) OR (updated_at = cursor.updatedAt AND id < cursor.id)
    whereClauses.push(
      or(
        lt(tasks.updatedAt, cursor.updatedAt),
        and(eq(tasks.updatedAt, cursor.updatedAt), lt(tasks.id, cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: tasks.id,
      code: tasks.code,
      profileSlug: tasks.profileSlug,
      title: tasks.title,
      status: tasks.status,
      reviewStatus: tasks.reviewStatus,
      updatedAt: tasks.updatedAt,
      startedAt: tasks.startedAt,
      completedAt: tasks.completedAt,
      source: hermesSessions.source,
      messageCount: hermesSessions.messageCount,
    })
    .from(tasks)
    .leftJoin(hermesSessions, eq(tasks.sourceHermesSessionId, hermesSessions.id))
    .where(and(...whereClauses))
    .orderBy(desc(tasks.updatedAt), desc(tasks.id))
    .limit(limit + 1); // + 1 để detect có nextCursor không

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    code: r.code,
    profileSlug: narrowProfile(r.profileSlug),
    title: r.title,
    status: r.status,
    reviewStatus: r.reviewStatus as string,
    updatedAt: r.updatedAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    source: r.source,
    messageCount: r.messageCount,
  }));
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null;
  return { items, nextCursor };
}

export async function getTaskById(id: string): Promise<TaskListItem | null> {
  const rows = await db
    .select({
      id: tasks.id,
      code: tasks.code,
      profileSlug: tasks.profileSlug,
      title: tasks.title,
      status: tasks.status,
      reviewStatus: tasks.reviewStatus,
      updatedAt: tasks.updatedAt,
      startedAt: tasks.startedAt,
      completedAt: tasks.completedAt,
      source: hermesSessions.source,
      messageCount: hermesSessions.messageCount,
    })
    .from(tasks)
    .leftJoin(hermesSessions, eq(tasks.sourceHermesSessionId, hermesSessions.id))
    .where(eq(tasks.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    profileSlug: narrowProfile(r.profileSlug),
    title: r.title,
    status: r.status,
    reviewStatus: r.reviewStatus as string,
    updatedAt: r.updatedAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    source: r.source,
    messageCount: r.messageCount,
  };
}
