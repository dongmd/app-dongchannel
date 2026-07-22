import Link from "next/link";
import { ChevronRight, MessageSquare } from "lucide-react";
import { getProfileFilter } from "@/lib/profiles/server";
import { PROFILE_LABELS } from "@/lib/profiles/types";
import { listTasks, type StatusGroup } from "@/lib/tasks/list";
import { TaskFilterTabs } from "@/components/tasks/task-filter-tabs";
import { TaskSearchInput } from "@/components/tasks/task-search-input";
import { TaskStatusBadge } from "@/components/tasks/task-status-badge";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const VALID_STATUS: StatusGroup[] = ["all", "pending_review", "running", "alerts", "completed"];

function pickStatus(raw: unknown): StatusGroup {
  if (typeof raw === "string" && (VALID_STATUS as string[]).includes(raw)) return raw as StatusGroup;
  return "all";
}

function pickString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function formatRelative(d: Date | null): string {
  if (!d) return "—";
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} ngày trước`;
  return d.toLocaleDateString("vi-VN");
}

export default async function TasksPage({ searchParams }: Props) {
  const sp = await searchParams;
  const profile = await getProfileFilter(sp);
  const status = pickStatus(sp["status"]);
  const q = pickString(sp["q"]);
  const cursor = pickString(sp["cursor"]);
  const profileLabel = PROFILE_LABELS[profile];

  const { items, nextCursor } = await listTasks({ profile, status, q, cursor, limit: 20 });

  const nextHref = (() => {
    if (!nextCursor) return null;
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (q) params.set("q", q);
    params.set("cursor", nextCursor);
    return `/tasks?${params.toString()}`;
  })();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Công việc</h1>
          <p className="text-sm text-muted-foreground">
            Nhiệm vụ nhập từ Hermes + tự tạo. Sort mặc định: cập nhật mới nhất trước.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Profile: <strong className="text-foreground">{profileLabel.short}</strong>
        </span>
      </header>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <TaskFilterTabs current={status} />
        <TaskSearchInput initial={q ?? ""} />
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {q || status !== "all" ? (
            <>
              Không có nhiệm vụ khớp bộ lọc.{" "}
              <Link href="/tasks" className="text-primary hover:underline">
                Xoá lọc
              </Link>
            </>
          ) : (
            <>
              Chưa có nhiệm vụ nào. Gửi mission cho bot Telegram hoặc chạy ingest từ trang{" "}
              <Link href="/admin" className="text-primary hover:underline">
                Quản trị
              </Link>
              .
            </>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-muted/5">
          {items.map((t) => (
            <li key={t.id}>
              <Link
                href={`/tasks/${t.id}` as never}
                className="flex items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                  {t.code}
                </span>
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="hidden shrink-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
                  {t.messageCount ? (
                    <>
                      <MessageSquare className="h-3 w-3" aria-hidden="true" />
                      {t.messageCount}
                    </>
                  ) : null}
                  <span>{PROFILE_LABELS[t.profileSlug].short}</span>
                  {t.source ? <span className="opacity-60">via {t.source}</span> : null}
                </span>
                <TaskStatusBadge status={t.status} />
                <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:inline">
                  {formatRelative(t.updatedAt)}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {nextHref ? (
        <div className="text-center">
          <Link
            href={nextHref as never}
            className="inline-flex items-center gap-1 rounded-md border border-border px-4 py-2 text-sm hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Xem thêm
          </Link>
        </div>
      ) : null}
    </div>
  );
}
