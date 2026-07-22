import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { ArrowLeft, ExternalLink, Sparkles } from "lucide-react";
import { getTaskDetail } from "@/lib/tasks/detail";
import { PROFILE_LABELS } from "@/lib/profiles/types";
import { authOptions } from "@/lib/auth/options";
import { TaskStatusBadge } from "@/components/tasks/task-status-badge";
import { MessageTimeline } from "@/components/tasks/message-timeline";
import { ReviewActions } from "@/components/tasks/review-actions";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [task, session] = await Promise.all([getTaskDetail(id), getServerSession(authOptions)]);
  if (!task) notFound();
  const canReview = session?.user?.role === "OWNER" || session?.user?.role === "ADMIN";

  const hermesUrl = process.env.NEXT_PUBLIC_HERMES_DASHBOARD_URL;
  // AC07 — Deep link tới session trên Hermes cũ. Nếu Hermes SPA có route sessions/:id sẽ hoạt động.
  const hermesSessionUrl = task.session && hermesUrl
    ? `${hermesUrl.replace(/\/$/, "")}/sessions/${task.session.hermesSessionId}`
    : null;

  const cost = task.session?.estimatedCostUsd;
  const costLabel =
    typeof cost === "number" ? `$${cost.toFixed(4)}` : "—";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href="/tasks"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Danh sách nhiệm vụ
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm text-muted-foreground">{task.code}</span>
          <TaskStatusBadge status={task.status} />
          <span className="text-xs text-muted-foreground">
            Profile: {PROFILE_LABELS[task.profileSlug].short}
          </span>
          {task.session?.source ? (
            <span className="text-xs text-muted-foreground">via {task.session.source}</span>
          ) : null}
          {hermesSessionUrl ? (
            <a
              href={hermesSessionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
            >
              Mở trên Hermes
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : null}
        </div>
        <h1 className="text-2xl font-semibold">{task.title}</h1>
      </header>

      {/* AC03 — Final answer prominent */}
      {task.finalAssistantMessage?.content ? (
        <section
          aria-labelledby="final-answer-heading"
          className="rounded-lg border border-primary/40 bg-primary/5 p-4"
        >
          <h2
            id="final-answer-heading"
            className="mb-2 flex items-center gap-2 text-sm font-medium text-primary"
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Trả lời cuối cùng
          </h2>
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {task.finalAssistantMessage.content}
          </div>
        </section>
      ) : null}

      {/* Meta grid */}
      <section
        aria-label="Thông tin session"
        className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-muted/10 p-4 text-sm md:grid-cols-4"
      >
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Model</div>
          <div className="mt-1 font-mono text-xs">{task.session?.model ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Tokens</div>
          <div className="mt-1 font-mono text-xs">
            {task.session ? `${task.session.inputTokens.toLocaleString()} in / ${task.session.outputTokens.toLocaleString()} out` : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Chi phí ước</div>
          <div className="mt-1 font-mono text-xs">{costLabel}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Message</div>
          <div className="mt-1 font-mono text-xs">{task.session?.messageCount ?? task.messages.length}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Bắt đầu</div>
          <div className="mt-1 text-xs">
            {task.startedAt ? task.startedAt.toLocaleString("vi-VN") : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Kết thúc</div>
          <div className="mt-1 text-xs">
            {task.completedAt ? task.completedAt.toLocaleString("vi-VN") : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Cập nhật</div>
          <div className="mt-1 text-xs">{task.updatedAt.toLocaleString("vi-VN")}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Session ID</div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            {task.session?.hermesSessionId ?? "—"}
          </div>
        </div>
      </section>

      {/* DC-009 — Review actions */}
      <ReviewActions
        taskId={task.id}
        status={task.status}
        updatedAt={task.updatedAt.toISOString()}
        canReview={canReview}
      />

      {/* AC02 — Timeline */}
      <MessageTimeline messages={task.messages} />
    </div>
  );
}
