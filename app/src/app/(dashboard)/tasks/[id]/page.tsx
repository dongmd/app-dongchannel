import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTaskById } from "@/lib/tasks/list";
import { PROFILE_LABELS } from "@/lib/profiles/types";
import { TaskStatusBadge } from "@/components/tasks/task-status-badge";

// AC06 — click row → detail. V1 stub, DC-008 sẽ thêm timeline + review actions.
export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const task = await getTaskById(id);
  if (!task) notFound();

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
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-muted-foreground">{task.code}</span>
          <TaskStatusBadge status={task.status} />
          <span className="text-xs text-muted-foreground">
            Profile: {PROFILE_LABELS[task.profileSlug].short}
          </span>
        </div>
        <h1 className="text-2xl font-semibold">{task.title}</h1>
      </header>

      <section className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-muted/10 p-4 text-sm md:grid-cols-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Nguồn</div>
          <div className="mt-1">{task.source ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Số message</div>
          <div className="mt-1">{task.messageCount ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Bắt đầu</div>
          <div className="mt-1">
            {task.startedAt ? task.startedAt.toLocaleString("vi-VN") : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Kết thúc</div>
          <div className="mt-1">
            {task.completedAt ? task.completedAt.toLocaleString("vi-VN") : "—"}
          </div>
        </div>
      </section>

      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Timeline message + tool calls + final answer + review actions sẽ có ở DC-008/009.
      </div>
    </div>
  );
}
