import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { YoutubeTabs } from "@/components/youtube/youtube-tabs";
import { NewVideoForm } from "@/components/youtube/new-video-form";

export default function NewVideoPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href="/youtube/videos"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        YouTube Videos
      </Link>

      <YoutubeTabs />

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Thêm video mới</h1>
        <p className="text-sm text-muted-foreground">
          Tạo video ở trạng thái IDEA. Sau đó VALIDATE → APPROVE → SCRIPT theo pipeline.
        </p>
      </header>

      <NewVideoForm />
    </div>
  );
}
