import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getVideoDetail, nextStatuses } from "@/lib/youtube/videos";
import { authOptions } from "@/lib/auth/options";
import { YoutubeTabs } from "@/components/youtube/youtube-tabs";
import { VideoStatusBadge } from "@/components/youtube/video-status-badge";
import { VideoTransitionButtons } from "@/components/youtube/video-transition-buttons";

export const dynamic = "force-dynamic";

export default async function VideoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [video, session] = await Promise.all([getVideoDetail(id), getServerSession(authOptions)]);
  if (!video) notFound();
  const canEdit = session?.user?.role === "OWNER" || session?.user?.role === "ADMIN";
  const next = nextStatuses(video.status);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href="/youtube/videos"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        YouTube Videos
      </Link>

      <YoutubeTabs />

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <VideoStatusBadge status={video.status} />
          {video.nicheName ? (
            <span className="text-xs text-muted-foreground">Niche: {video.nicheName}</span>
          ) : null}
          {video.offerName ? (
            <span className="text-xs text-muted-foreground">Offer: {video.offerName}</span>
          ) : null}
          {video.copyrightRisk ? (
            <span className="text-xs text-muted-foreground">Copyright risk: {video.copyrightRisk}</span>
          ) : null}
        </div>
        <h1 className="text-2xl font-semibold">{video.title ?? video.workingTitle}</h1>
        {video.title && video.workingTitle !== video.title ? (
          <p className="font-mono text-xs text-muted-foreground">Working: {video.workingTitle}</p>
        ) : null}
        {video.publishUrl ? (
          <a
            href={video.publishUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {video.publishUrl}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ) : null}
      </header>

      {canEdit && next.length > 0 ? (
        <VideoTransitionButtons
          videoId={video.id}
          currentStatus={video.status}
          allowed={next}
          currentPublishUrl={video.publishUrl}
        />
      ) : null}

      <section
        aria-label="Chi tiết video"
        className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-muted/10 p-4 text-sm md:grid-cols-3"
      >
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Đăng</div>
          <div className="mt-1 text-xs">
            {video.publishedAt ? video.publishedAt.toLocaleString("vi-VN") : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Tạo</div>
          <div className="mt-1 text-xs">{video.createdAt.toLocaleDateString("vi-VN")}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Cập nhật</div>
          <div className="mt-1 text-xs">{video.updatedAt.toLocaleString("vi-VN")}</div>
        </div>
      </section>

      {video.hook ? (
        <section aria-labelledby="hook-heading" className="space-y-2">
          <h2 id="hook-heading" className="text-sm font-medium text-muted-foreground">
            Hook
          </h2>
          <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/10 p-3 text-sm">
            {video.hook}
          </p>
        </section>
      ) : null}

      {video.outline ? (
        <section aria-labelledby="outline-heading" className="space-y-2">
          <h2 id="outline-heading" className="text-sm font-medium text-muted-foreground">
            Outline
          </h2>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/10 p-3 font-mono text-xs">
            {video.outline}
          </pre>
        </section>
      ) : null}

      {video.script ? (
        <section aria-labelledby="script-heading" className="space-y-2">
          <h2 id="script-heading" className="text-sm font-medium text-muted-foreground">
            Script
          </h2>
          <div className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/10 p-3 text-sm">
            {video.script}
          </div>
        </section>
      ) : null}

      <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
        Video variants (A/B title/thumbnail/hook) + Metrics form sẽ có ở DC-014 (Result forms).
      </div>
    </div>
  );
}
