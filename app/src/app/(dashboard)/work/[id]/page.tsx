/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL read models (core-web.ts), typed at the boundary in TDD 14.9 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser, lumiDb } from "@/lib/lumi-m1/server";
import { getTaskDetail } from "@/lib/lumi-m1/core-web";
import { WorkStatusBadge } from "@/components/work/work-status";
import { TaskActions } from "@/components/work/task-actions";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (d: unknown) => (d ? new Date(d as string).toLocaleString("vi-VN") : "—");

export default async function WorkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const user = await currentUser();
  if (!user) redirect("/login");
  const d = await getTaskDetail(lumiDb(), id);
  if (!d || !d.task.project_id) notFound();
  const { task, runs, outputs, activities, approvals } = d;
  const current = outputs.find((o: any) => o.id === task.current_output_id) ?? null;
  const late = outputs.filter((o: any) => o.state === "LATE_SAVED");
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/work" className="text-xs text-muted-foreground hover:underline">
        ← Danh sách việc
      </Link>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm text-muted-foreground">{task.code}</span>
          <WorkStatusBadge status={task.status} />
        </div>
        <h1 className="text-xl font-semibold">{task.title}</h1>
        <p className="text-xs text-muted-foreground">
          Dự án {task.project_name} · giao cho {task.assistant_name ?? task.owner_actor_ref} · vòng sửa {task.revision_round}
        </p>
        {task.description && <p className="whitespace-pre-wrap text-sm">{task.description}</p>}
        {task.error_code && (
          <p role="alert" className="text-sm text-destructive">
            Lỗi {task.error_code}
            {task.error_message ? `: ${task.error_message}` : ""}
          </p>
        )}
        {task.hold_reason && <p className="text-sm text-amber-500">Lý do giữ/hủy: {task.hold_reason}</p>}
      </header>

      <TaskActions
        taskId={task.id}
        status={task.status}
        role={user.role}
        needsDecision={task.needs_decision}
        current={current ? { id: current.id, version: current.version, state: current.state, late: current.late } : null}
        lateOutputs={late.map((o: any) => ({ id: o.id, version: o.version, state: o.state, late: true }))}
      />

      <section aria-label="Đầu ra" className="space-y-2">
        <h2 className="text-sm font-semibold">Đầu ra ({outputs.length})</h2>
        {outputs.length === 0 && <p className="text-sm text-muted-foreground">Chưa có đầu ra.</p>}
        {outputs.map((o: any) => (
          <article key={o.id} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Bản {o.version}</span>
              <span>{o.state}</span>
              {o.late && <span>(đến muộn)</span>}
              {o.id === task.current_output_id && <span className="text-primary">● bản hiện tại</span>}
              <span className="ml-auto">
                {fmt(o.created_at)} · {o.submitted_by}
              </span>
            </div>
            <pre className="whitespace-pre-wrap text-sm">{o.content}</pre>
          </article>
        ))}
      </section>

      <section aria-label="Lần chạy" className="space-y-2">
        <h2 className="text-sm font-semibold">Lần chạy ({runs.length})</h2>
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {runs.map((r: any) => (
            <li key={r.id} className="flex flex-wrap gap-x-3 px-3 py-2">
              <span>#{r.attempt_no}</span>
              <span>{r.run_kind}</span>
              <span className="font-medium">{r.state}</span>
              {r.remote_stop_state !== "NONE" && (
                <span className="text-xs text-muted-foreground">
                  dừng từ xa: {r.remote_stop_state === "CONFIRMED" ? "đã xác nhận" : "CHƯA xác nhận (app ngừng chờ không có nghĩa bot đã dừng)"}
                </span>
              )}
              {r.error_code && <span className="text-destructive">{r.error_code}</span>}
              <span className="ml-auto text-xs text-muted-foreground">{fmt(r.created_at)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Quyết định" className="space-y-2">
        <h2 className="text-sm font-semibold">Quyết định duyệt ({approvals.length})</h2>
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {approvals.map((a: any, i: number) => (
            <li key={i} className="px-3 py-2">
              Bản {a.object_version}: <b>{a.decision}</b>
              {a.reason ? ` — ${a.reason}` : ""}{" "}
              <span className="text-xs text-muted-foreground">
                ({a.decided_by}, {a.channel}, {fmt(a.decided_at)})
              </span>
            </li>
          ))}
          {approvals.length === 0 && <li className="px-3 py-2 text-muted-foreground">Chưa có.</li>}
        </ul>
      </section>

      <section aria-label="Nhật ký" className="space-y-2">
        <h2 className="text-sm font-semibold">Nhật ký hoạt động</h2>
        <ol className="space-y-1 text-xs text-muted-foreground">
          {activities.map((a: any, i: number) => (
            <li key={i}>
              {fmt(a.occurred_at)} — {a.event_type}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
