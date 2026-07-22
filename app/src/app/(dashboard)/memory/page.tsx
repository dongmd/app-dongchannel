import { getServerSession } from "next-auth";
import { getProfileFilter } from "@/lib/profiles/server";
import { PROFILE_LABELS } from "@/lib/profiles/types";
import { authOptions } from "@/lib/auth/options";
import { listMemory, countPendingMemory, type MemoryTab } from "@/lib/memory/list";
import { MemoryTabs } from "@/components/memory/memory-tabs";
import { MemoryCard } from "@/components/memory/memory-card";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const VALID_TABS: MemoryTab[] = ["pending", "user_profile", "decision", "playbook"];

function pickTab(raw: unknown): MemoryTab {
  if (typeof raw === "string" && (VALID_TABS as string[]).includes(raw)) return raw as MemoryTab;
  return "pending";
}

const TAB_EMPTY_HINT: Record<MemoryTab, string> = {
  pending: "Không có memory proposal nào chờ duyệt. Auto-extractor sẽ có ở V1.1 — trong lúc chờ, bạn có thể INSERT thủ công qua SQL để test flow.",
  user_profile: "Chưa có memory User Profile đã duyệt. Sau khi duyệt proposal, entry sẽ hiện ở đây.",
  decision: "Chưa có Decision đã duyệt.",
  playbook: "Chưa có Playbook rule nào đã duyệt.",
};

export default async function MemoryPage({ searchParams }: Props) {
  const sp = await searchParams;
  const profile = await getProfileFilter(sp);
  const tab = pickTab(sp["tab"]);

  const [items, pendingCount, session] = await Promise.all([
    listMemory({ tab, profile }),
    countPendingMemory(profile),
    getServerSession(authOptions),
  ]);
  const canReview = session?.user?.role === "OWNER" || session?.user?.role === "ADMIN";
  const profileLabel = PROFILE_LABELS[profile];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Trí nhớ</h1>
          <p className="text-sm text-muted-foreground">
            Proposal chờ duyệt → ACTIVE → SUPERSEDED/REJECTED/ARCHIVED. Bot chỉ đề xuất, người
            duyệt.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Profile: <strong className="text-foreground">{profileLabel.short}</strong>
        </span>
      </header>

      <MemoryTabs current={tab} pendingCount={pendingCount} />

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {TAB_EMPTY_HINT[tab]}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {items.map((entry) => (
            <MemoryCard key={entry.id} entry={entry} canReview={canReview} />
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        V1: auto-extractor chưa có — proposal tạo bằng INSERT SQL hoặc từ task detail (V1.1). BR02:
        không active nếu không có source hoặc manual_entry=true.
      </p>
    </div>
  );
}
