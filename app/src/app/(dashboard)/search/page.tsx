import Link from "next/link";
import { ChevronRight, Search as SearchIcon } from "lucide-react";
import { unifiedSearch, type SearchEntityType } from "@/lib/search/search";
import { getProfileFilter } from "@/lib/profiles/server";
import { PROFILE_LABELS } from "@/lib/profiles/types";
import { HighlightedSnippet } from "@/components/search/highlighted-snippet";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const VALID_TYPES: SearchEntityType[] = [
  "task",
  "memory",
  "offer",
  "video",
  "niche",
  "market",
  "message",
];

function pickType(raw: unknown): SearchEntityType | "all" {
  if (typeof raw !== "string") return "all";
  if ((VALID_TYPES as string[]).includes(raw)) return raw as SearchEntityType;
  return "all";
}

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = typeof sp["q"] === "string" ? sp["q"] : "";
  const type = pickType(sp["type"]);
  const profile = await getProfileFilter(sp);
  const profileLabel = PROFILE_LABELS[profile];

  const result = q.trim() ? await unifiedSearch({ q, profile, type }) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Tìm kiếm</h1>
          <p className="text-sm text-muted-foreground">
            Tìm cross entity: tasks, trí nhớ, offer, video, niche, market, message. FTS đơn giản
            (V1) — semantic sẽ có ở V1.1.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Profile: <strong className="text-foreground">{profileLabel.short}</strong>
        </span>
      </header>

      {!q.trim() ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          <SearchIcon className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
          Nhập từ khoá vào ô tìm kiếm phía trên. Search theo tiêu đề/nội dung, không phân biệt hoa
          thường.
        </div>
      ) : !result || result.totalMatched === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Không có kết quả cho <strong>&quot;{q}&quot;</strong>. Thử từ khoá khác hoặc bỏ dấu.
        </div>
      ) : (
        <div className="space-y-6">
          <p className="text-xs text-muted-foreground">
            {result.totalMatched} kết quả cho <strong>&quot;{q}&quot;</strong>
            {type !== "all" ? ` (chỉ nhóm ${type})` : ""}
          </p>
          {result.groups.map((group) => (
            <section key={group.type} aria-labelledby={`group-${group.type}`}>
              <h2
                id={`group-${group.type}`}
                className="mb-2 text-sm font-medium text-muted-foreground"
              >
                {group.label} ({group.items.length})
              </h2>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-muted/5">
                {group.items.map((item) => (
                  <li key={`${item.type}-${item.id}`}>
                    <Link
                      href={item.href as never}
                      className="flex items-start gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{item.title}</span>
                          {item.meta ? (
                            <span className="text-xs text-muted-foreground">· {item.meta}</span>
                          ) : null}
                        </div>
                        <HighlightedSnippet snippet={item.snippet} />
                      </div>
                      <ChevronRight
                        className="mt-1 h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
