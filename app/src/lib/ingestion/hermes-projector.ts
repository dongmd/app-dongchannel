import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { profiles, PROFILE_SLUGS, type ProfileSlug } from "@/lib/db/schema/profiles";
import { hermesMessages, hermesSessions } from "@/lib/db/schema/hermes";
import { tasks } from "@/lib/db/schema/tasks";
import { exportSessionsJsonl } from "@/lib/hermes/exec";

// AC03/AC04/AC06 — pull sessions từ Hermes CLI, upsert idempotent, derive tasks.
// V1: mỗi session → 1 task status IMPORTED (backfill lịch sử).
// Chưa map WAITING_REVIEW vì cần logic detect final-answer chưa duyệt (defer DC-009).

export interface IngestResult {
  profile: ProfileSlug;
  sessionsSeen: number;
  sessionsInserted: number;
  sessionsUpdated: number;
  messagesInserted: number;
  tasksCreated: number;
  errors: string[];
  durationMs: number;
}

// Ensure profile rows tồn tại trước khi FK — idempotent seed.
async function ensureProfilesSeeded(): Promise<void> {
  const rows = PROFILE_SLUGS.map((slug) => ({
    slug,
    name:
      slug === "aff" ? "AFF Research Bot" : slug === "yt" ? "YouTube Global Bot" : "Default",
    type: slug === "default" ? "system" : "bot",
  }));
  for (const row of rows) {
    await db.insert(profiles).values(row).onConflictDoNothing({ target: profiles.slug });
  }
}

function unixToDate(v: unknown): Date | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return new Date(v * 1000);
}

function toStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function toInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
}

// Task code auto-increment per profile prefix: AFF-0001, YT-0001, DEF-0001.
async function nextTaskCode(profile: ProfileSlug): Promise<string> {
  const prefix = profile === "aff" ? "AFF" : profile === "yt" ? "YT" : "DEF";
  const [row] = await db
    .select({ n: count() })
    .from(tasks)
    .where(eq(tasks.profileSlug, profile));
  const next = (row?.n ?? 0) + 1;
  return `${prefix}-${String(next).padStart(4, "0")}`;
}

export async function ingestProfile(profile: ProfileSlug): Promise<IngestResult> {
  const start = performance.now();
  const result: IngestResult = {
    profile,
    sessionsSeen: 0,
    sessionsInserted: 0,
    sessionsUpdated: 0,
    messagesInserted: 0,
    tasksCreated: 0,
    errors: [],
    durationMs: 0,
  };

  await ensureProfilesSeeded();

  let sessions: unknown[];
  try {
    sessions = await exportSessionsJsonl(profile);
  } catch (err) {
    result.errors.push((err as Error).message);
    result.durationMs = Math.round(performance.now() - start);
    return result;
  }

  for (const raw of sessions) {
    result.sessionsSeen++;
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const hermesSessionId = toStr(s.id);
    if (!hermesSessionId) {
      result.errors.push("session missing id");
      continue;
    }

    try {
      // Upsert session
      const sessionValues = {
        profileSlug: profile,
        hermesSessionId,
        source: toStr(s.source),
        chatId: toStr(s.chat_id),
        userId: toStr(s.user_id),
        chatType: toStr(s.chat_type),
        displayName: toStr(s.display_name),
        title: toStr(s.title) ?? toStr(s.display_name) ?? hermesSessionId,
        model: toStr(s.model),
        startedAt: unixToDate(s.started_at),
        lastActiveAt: unixToDate(s.last_active),
        endedAt: unixToDate(s.ended_at),
        endReason: toStr(s.end_reason),
        messageCount: toInt(s.message_count),
        toolCallCount: toInt(s.tool_call_count),
        inputTokens: toInt(s.input_tokens),
        outputTokens: toInt(s.output_tokens),
        estimatedCostUsd:
          typeof s.estimated_cost_usd === "number" ? (s.estimated_cost_usd as number) : null,
        archived: toInt(s.archived),
        rawMetadata: {
          session_key: s.session_key,
          origin_json: s.origin_json,
          model_config: s.model_config,
          billing_provider: s.billing_provider,
          api_call_count: s.api_call_count,
          reasoning_tokens: s.reasoning_tokens,
          cache_read_tokens: s.cache_read_tokens,
        },
        updatedAt: new Date(),
      };

      // Idempotent upsert via unique (profile, hermes_session_id).
      const [sessionRow] = await db
        .insert(hermesSessions)
        .values(sessionValues)
        .onConflictDoUpdate({
          target: [hermesSessions.profileSlug, hermesSessions.hermesSessionId],
          set: {
            title: sessionValues.title,
            lastActiveAt: sessionValues.lastActiveAt,
            endedAt: sessionValues.endedAt,
            endReason: sessionValues.endReason,
            messageCount: sessionValues.messageCount,
            toolCallCount: sessionValues.toolCallCount,
            inputTokens: sessionValues.inputTokens,
            outputTokens: sessionValues.outputTokens,
            estimatedCostUsd: sessionValues.estimatedCostUsd,
            archived: sessionValues.archived,
            rawMetadata: sessionValues.rawMetadata,
            updatedAt: sessionValues.updatedAt,
          },
        })
        .returning({ id: hermesSessions.id, isNew: sql<boolean>`(xmax = 0)` });

      if (!sessionRow) throw new Error("upsert returned no row");
      if (sessionRow.isNew) result.sessionsInserted++;
      else result.sessionsUpdated++;

      // Messages: insert từng cái với on-conflict-do-nothing (idempotent per external_message_id).
      const messages = Array.isArray(s.messages) ? (s.messages as Record<string, unknown>[]) : [];
      for (const m of messages) {
        const externalMessageId = toInt(m.id);
        if (!externalMessageId) continue;
        const inserted = await db
          .insert(hermesMessages)
          .values({
            sessionId: sessionRow.id,
            externalMessageId,
            role: toStr(m.role) ?? "unknown",
            content: toStr(m.content),
            toolName: toStr(m.tool_name),
            toolCallId: toStr(m.tool_call_id),
            tokenCount: typeof m.token_count === "number" ? (m.token_count as number) : null,
            finishReason: toStr(m.finish_reason),
            occurredAt: unixToDate(m.timestamp),
            rawJson: m,
          })
          .onConflictDoNothing({
            target: [hermesMessages.sessionId, hermesMessages.externalMessageId],
          })
          .returning({ id: hermesMessages.id });
        if (inserted.length > 0) result.messagesInserted++;
      }

      // Derive task if session chưa có task tương ứng (idempotent qua unique(source_hermes_session_id)).
      const existingTask = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.sourceHermesSessionId, sessionRow.id))
        .limit(1);
      if (existingTask.length === 0) {
        const code = await nextTaskCode(profile);
        await db.insert(tasks).values({
          code,
          profileSlug: profile,
          sourceHermesSessionId: sessionRow.id,
          title: sessionValues.title,
          type: "general",
          status: "IMPORTED",
          reviewStatus: "NONE",
          startedAt: sessionValues.startedAt,
          completedAt: sessionValues.endedAt,
        });
        result.tasksCreated++;
      }
    } catch (err) {
      result.errors.push(`session ${hermesSessionId}: ${(err as Error).message}`);
    }
  }

  result.durationMs = Math.round(performance.now() - start);
  return result;
}

// Ingest all profile song song (Promise.all) — mỗi ingest độc lập.
export async function ingestAll(): Promise<IngestResult[]> {
  const results = await Promise.all(PROFILE_SLUGS.map((p) => ingestProfile(p)));
  return results;
}

// Query util cho summary aggregator.
export async function getRecentTasks(limit = 5): Promise<
  { code: string; title: string; profileSlug: string; status: string; completedAt: Date | null }[]
> {
  const rows = await db
    .select({
      code: tasks.code,
      title: tasks.title,
      profileSlug: tasks.profileSlug,
      status: tasks.status,
      completedAt: tasks.completedAt,
    })
    .from(tasks)
    .orderBy(desc(tasks.updatedAt))
    .limit(limit);
  return rows;
}
