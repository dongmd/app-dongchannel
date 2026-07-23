"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Check, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface NotificationItem {
  id: string;
  type: string;
  entityType: string | null;
  entityId: string | null;
  title: string;
  body: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

interface Payload {
  items: NotificationItem[];
  unreadCount: number;
}

export function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  async function fetchList() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/notifications", { cache: "no-store" });
      const body = (await res.json()) as { data: Payload | null };
      if (body.data) {
        setItems(body.data.items);
        setUnread(body.data.unreadCount);
      }
    } catch {
      // giữ state
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchList();
    // AC06 — subscribe SSE
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/v1/notifications/stream");
      es.addEventListener("notification", () => {
        void fetchList();
      });
      es.addEventListener("error", () => {
        // Polling fallback mỗi 60s (nếu SSE fail)
      });
      eventSourceRef.current = es;
    } catch {
      // Fallback poll
      const id = setInterval(fetchList, 60_000);
      return () => clearInterval(id);
    }
    // Polling backup mỗi 5 phút để catch cases SSE bỏ sót
    const poll = setInterval(fetchList, 5 * 60_000);
    return () => {
      es?.close();
      eventSourceRef.current = null;
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleItemClick(item: NotificationItem) {
    if (!item.readAt) {
      // Fire-and-forget mark read
      void fetch(`/api/v1/notifications/${item.id}/read`, { method: "POST" }).then(() => fetchList());
    }
    setOpen(false);
    if (item.href) router.push(item.href as never);
  }

  async function readAll() {
    await fetch("/api/v1/notifications/read-all", { method: "POST" });
    await fetchList();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Thông báo — ${unreadCount} chưa đọc`}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "relative rounded-md border border-border p-1.5 transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring",
          unreadCount > 0 && "text-primary",
        )}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Danh sách thông báo"
          className="absolute right-0 top-full z-40 mt-1 w-80 overflow-hidden rounded-md border border-border bg-background shadow-lg"
        >
          <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
            <span className="font-medium">
              Thông báo{unreadCount > 0 ? ` (${unreadCount} chưa đọc)` : ""}
            </span>
            {unreadCount > 0 ? (
              <button
                type="button"
                onClick={readAll}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-muted-foreground hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <CheckCheck className="h-3 w-3" aria-hidden="true" />
                Đánh dấu đã đọc hết
              </button>
            ) : null}
          </header>

          <ul className="max-h-96 divide-y divide-border overflow-y-auto">
            {loading && items.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">Đang tải…</li>
            ) : items.length === 0 ? (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                Chưa có thông báo.
              </li>
            ) : (
              items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleItemClick(item)}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring",
                      !item.readAt && "bg-primary/5",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                        item.readAt ? "bg-muted-foreground/30" : "bg-primary",
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{item.title}</div>
                      {item.body ? (
                        <div className="line-clamp-2 text-xs text-muted-foreground">
                          {item.body}
                        </div>
                      ) : null}
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {new Date(item.createdAt).toLocaleString("vi-VN")}
                      </div>
                    </div>
                    {item.readAt ? (
                      <Check className="mt-1 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>

          <footer className="border-t border-border px-3 py-2 text-center text-[11px] text-muted-foreground">
            <Link href="/tasks" className="hover:text-foreground" onClick={() => setOpen(false)}>
              Xem tất cả nhiệm vụ →
            </Link>
          </footer>
        </div>
      ) : null}
    </div>
  );
}
