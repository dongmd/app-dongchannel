"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Code2 } from "lucide-react";
import type { TaskDetailMessage } from "@/lib/tasks/detail";
import { cn } from "@/lib/utils";

// AC04/AC05/AC06 — role badge, tool call collapse, session_meta italic, truncate content.

const ROLE_STYLES: Record<string, { label: string; badge: string; container: string }> = {
  user: {
    label: "Người dùng",
    badge: "bg-primary/15 text-primary",
    container: "border-primary/30",
  },
  assistant: {
    label: "Trợ lý",
    badge: "bg-muted text-foreground",
    container: "border-border",
  },
  tool: {
    label: "Tool",
    badge: "bg-amber-500/15 text-amber-500",
    container: "border-amber-500/30",
  },
  session_meta: {
    label: "System event",
    badge: "bg-muted-foreground/15 text-muted-foreground",
    container: "border-dashed border-border/60",
  },
  unknown: {
    label: "Khác",
    badge: "bg-muted text-muted-foreground",
    container: "border-border",
  },
};

const TRUNCATE_LEN = 500;

export function MessageItem({ message }: { message: TaskDetailMessage }) {
  const style = ROLE_STYLES[message.role] ?? ROLE_STYLES["unknown"]!;
  const isMeta = message.role === "session_meta";
  const isTool = message.role === "tool";
  const [showRaw, setShowRaw] = useState(false);
  const [expanded, setExpanded] = useState(!isTool);

  const content = message.content ?? "";
  const truncated = content.length > TRUNCATE_LEN;
  const [showFull, setShowFull] = useState(false);
  const displayContent = truncated && !showFull ? content.slice(0, TRUNCATE_LEN) + "…" : content;

  const timestamp = message.occurredAt
    ? message.occurredAt.toLocaleTimeString("vi-VN")
    : "";

  return (
    <article
      className={cn(
        "rounded-lg border p-3 text-sm",
        style.container,
        isMeta && "bg-muted/5 text-muted-foreground italic",
      )}
    >
      <header className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Thu gọn" : "Mở rộng"}
          className="rounded p-0.5 hover:bg-accent"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", style.badge)}>
          {style.label}
        </span>
        {message.toolName ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            tool: {message.toolName}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span>#{message.externalMessageId}</span>
          {timestamp ? <span>{timestamp}</span> : null}
          {message.tokenCount ? <span>{message.tokenCount} tk</span> : null}
        </span>
      </header>

      {expanded ? (
        <>
          {content ? (
            <div className="whitespace-pre-wrap break-words leading-relaxed">
              {displayContent}
              {truncated ? (
                <button
                  type="button"
                  onClick={() => setShowFull((v) => !v)}
                  className="ml-2 text-xs text-primary hover:underline"
                >
                  {showFull ? "Rút gọn" : "Xem thêm"}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">(không có content)</div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              aria-expanded={showRaw}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <Code2 className="h-3 w-3" aria-hidden="true" />
              {showRaw ? "Ẩn raw JSON" : "Xem raw JSON"}
            </button>
            {message.finishReason ? (
              <span className="text-[11px] text-muted-foreground">
                finish: {message.finishReason}
              </span>
            ) : null}
          </div>
          {showRaw ? (
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-snug">
              {JSON.stringify(message.rawJson, null, 2)}
            </pre>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
