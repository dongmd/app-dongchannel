import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks, type TaskStatus, type TaskReviewStatus } from "@/lib/db/schema/tasks";
import { hermesMessages, hermesSessions } from "@/lib/db/schema/hermes";

export interface TaskDetailMessage {
  id: string;
  externalMessageId: number;
  role: string;
  content: string | null;
  toolName: string | null;
  toolCallId: string | null;
  tokenCount: number | null;
  finishReason: string | null;
  occurredAt: Date | null;
  rawJson: unknown;
}

export interface TaskDetail {
  id: string;
  code: string;
  profileSlug: "aff" | "yt";
  title: string;
  status: TaskStatus;
  reviewStatus: TaskReviewStatus;
  type: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  session: {
    id: string;
    hermesSessionId: string;
    source: string | null;
    chatId: string | null;
    userId: string | null;
    displayName: string | null;
    model: string | null;
    messageCount: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number | null;
  } | null;
  messages: TaskDetailMessage[];
  finalAssistantMessage: TaskDetailMessage | null;
}

function narrowProfile(slug: string): "aff" | "yt" {
  return slug === "aff" || slug === "yt" ? slug : "aff";
}

export async function getTaskDetail(id: string): Promise<TaskDetail | null> {
  const taskRows = await db
    .select({
      id: tasks.id,
      code: tasks.code,
      profileSlug: tasks.profileSlug,
      title: tasks.title,
      type: tasks.type,
      status: tasks.status,
      reviewStatus: tasks.reviewStatus,
      startedAt: tasks.startedAt,
      completedAt: tasks.completedAt,
      updatedAt: tasks.updatedAt,
      sourceHermesSessionId: tasks.sourceHermesSessionId,
    })
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1);
  const t = taskRows[0];
  if (!t) return null;

  let session: TaskDetail["session"] = null;
  let messages: TaskDetailMessage[] = [];

  if (t.sourceHermesSessionId) {
    const [sessionRow] = await db
      .select({
        id: hermesSessions.id,
        hermesSessionId: hermesSessions.hermesSessionId,
        source: hermesSessions.source,
        chatId: hermesSessions.chatId,
        userId: hermesSessions.userId,
        displayName: hermesSessions.displayName,
        model: hermesSessions.model,
        messageCount: hermesSessions.messageCount,
        inputTokens: hermesSessions.inputTokens,
        outputTokens: hermesSessions.outputTokens,
        estimatedCostUsd: hermesSessions.estimatedCostUsd,
      })
      .from(hermesSessions)
      .where(eq(hermesSessions.id, t.sourceHermesSessionId))
      .limit(1);
    if (sessionRow) {
      session = sessionRow;

      const msgRows = await db
        .select({
          id: hermesMessages.id,
          externalMessageId: hermesMessages.externalMessageId,
          role: hermesMessages.role,
          content: hermesMessages.content,
          toolName: hermesMessages.toolName,
          toolCallId: hermesMessages.toolCallId,
          tokenCount: hermesMessages.tokenCount,
          finishReason: hermesMessages.finishReason,
          occurredAt: hermesMessages.occurredAt,
          rawJson: hermesMessages.rawJson,
        })
        .from(hermesMessages)
        .where(eq(hermesMessages.sessionId, t.sourceHermesSessionId))
        .orderBy(asc(hermesMessages.externalMessageId));
      messages = msgRows;
    }
  }

  // AC03 — final answer = message assistant cuối cùng có content không rỗng.
  const finalAssistantMessage =
    [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content && m.content.trim().length > 0) ?? null;

  return {
    id: t.id,
    code: t.code,
    profileSlug: narrowProfile(t.profileSlug),
    title: t.title,
    status: t.status,
    reviewStatus: t.reviewStatus,
    type: t.type,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    updatedAt: t.updatedAt,
    session,
    messages,
    finalAssistantMessage,
  };
}
