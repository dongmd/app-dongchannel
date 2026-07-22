import { MessageSquare } from "lucide-react";
import type { TaskDetailMessage } from "@/lib/tasks/detail";
import { MessageItem } from "./message-item";

export function MessageTimeline({ messages }: { messages: TaskDetailMessage[] }) {
  return (
    <section aria-labelledby="timeline-heading" className="space-y-3">
      <h2
        id="timeline-heading"
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground"
      >
        <MessageSquare className="h-4 w-4" aria-hidden="true" />
        Timeline ({messages.length} message)
      </h2>
      {messages.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Không có message. Session có thể chưa được ingest — chạy{" "}
          <code className="font-mono text-xs">POST /api/v1/admin/ingest</code>.
        </div>
      ) : (
        <div className="space-y-2">
          {messages.map((m) => (
            <MessageItem key={m.id} message={m} />
          ))}
        </div>
      )}
    </section>
  );
}
