import Link from "next/link";
import { ChevronRight, ExternalLink, Plus } from "lucide-react";
import { listVideos, VIDEO_STATUS_LABELS } from "@/lib/youtube/videos";
import { videoStatusEnum, type VideoStatus } from "@/lib/db/schema/youtube";
import { YoutubeTabs } from "@/components/youtube/youtube-tabs";
import { VideoStatusBadge } from "@/components/youtube/video-status-badge";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const STATUS_VALUES = videoStatusEnum.enumValues as VideoStatus[];

function pickStatus(raw: unknown): VideoStatus | "all" {
  if (typeof raw !== "string") return "all";
  if ((STATUS_VALUES as string[]).includes(raw)) return raw as VideoStatus;
  return "all";
}

export default async function YoutubeVideosPage({ searchParams }: Props) {
  const sp = await searchParams;
  const status = pickStatus(sp["status"]);
  const q = typeof sp["q"] === "string" ? sp["q"] : undefined;

  const items = await listVideos({ status, q });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">YouTube</h1>
          <p className="text-sm text-muted-foreground">
            Pipeline: IDEA → VALIDATING → APPROVED → SCRIPTING → PRODUCING → SCHEDULED → PUBLISHED → REVIEWED
          </p>
        </div>
        <Link
          href="/youtube/videos/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Thêm video
        </Link>
      </header>

      <YoutubeTabs />

      <div className="flex flex-wrap gap-1.5 text-xs">
        <Link
          href="/youtube/videos"
          className={`rounded-full border px-3 py-1 transition-colors ${status === "all" ? "border-primary text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
        >
          Tất cả
        </Link>
        {STATUS_VALUES.map((s) => (
          <Link
            key={s}
            href={`/youtube/videos?status=${s}`}
            className={`rounded-full border px-3 py-1 transition-colors ${status === s ? "border-primary text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
          >
            {VIDEO_STATUS_LABELS[s]}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {status === "all" ? (
            <>
              Chưa có video nào. Thêm bằng nút <strong>Thêm video</strong> hoặc gửi mission cho
              YouTube Bot qua Telegram.
            </>
          ) : (
            <>
              Không có video ở trạng thái <strong>{VIDEO_STATUS_LABELS[status]}</strong>.{" "}
              <Link href="/youtube/videos" className="text-primary hover:underline">
                Xem tất cả
              </Link>
            </>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-muted/5">
          {items.map((v) => (
            <li key={v.id}>
              <Link
                href={`/youtube/videos/${v.id}`}
                className="flex items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{v.title ?? v.workingTitle}</span>
                    {v.title && v.workingTitle !== v.title ? (
                      <span className="text-xs text-muted-foreground">/ {v.workingTitle}</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {v.nicheName ? <span>Niche: {v.nicheName}</span> : null}
                    {v.offerName ? <span>· Offer: {v.offerName}</span> : null}
                    {v.publishedAt ? (
                      <span>· Đăng: {v.publishedAt.toLocaleDateString("vi-VN")}</span>
                    ) : null}
                  </div>
                </div>
                {v.publishUrl ? (
                  <a
                    href={v.publishUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                ) : null}
                <VideoStatusBadge status={v.status} />
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
