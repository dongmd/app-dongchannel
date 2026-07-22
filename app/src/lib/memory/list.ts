import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  memoryEntries,
  type MemoryCategory,
  type MemoryScope,
  type MemoryStatus,
} from "@/lib/db/schema/memory";
import { tasks } from "@/lib/db/schema/tasks";
import type { ProfileFilter } from "@/lib/profiles/types";

// Tabs UI mapping. Note: "Playbook" gộp playbook + fact (đủ cho V1).
export type MemoryTab = "pending" | "user_profile" | "decision" | "playbook";

const TAB_STATUS: Record<MemoryTab, MemoryStatus[]> = {
  pending: ["PROPOSED"],
  user_profile: ["ACTIVE"],
  decision: ["ACTIVE"],
  playbook: ["ACTIVE"],
};

const TAB_CATEGORY: Record<MemoryTab, MemoryCategory[] | null> = {
  pending: null, // all categories khi chờ duyệt
  user_profile: ["user_profile"],
  decision: ["decision"],
  playbook: ["playbook", "fact"],
};

export interface MemoryListItem {
  id: string;
  profileScope: MemoryScope;
  category: MemoryCategory;
  title: string;
  content: string;
  status: MemoryStatus;
  confidence: number | null;
  sourceTaskCode: string | null;
  sourceTaskId: string | null;
  manualEntry: boolean;
  reasonText: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function scopeFilter(profile: ProfileFilter): MemoryScope[] {
  // Overview 'all' = shared + aff + yt; 'aff' = aff + shared; 'yt' = yt + shared.
  if (profile === "aff") return ["shared", "aff"];
  if (profile === "yt") return ["shared", "yt"];
  return ["shared", "aff", "yt"];
}

export async function listMemory(input: {
  tab: MemoryTab;
  profile: ProfileFilter;
  limit?: number;
}): Promise<MemoryListItem[]> {
  const limit = Math.min(input.limit ?? 50, 200);
  const scopes = scopeFilter(input.profile);
  const statuses = TAB_STATUS[input.tab];
  const categories = TAB_CATEGORY[input.tab];

  const whereClauses = [
    inArray(memoryEntries.profileScope, scopes),
    inArray(memoryEntries.status, statuses),
  ];
  if (categories) whereClauses.push(inArray(memoryEntries.category, categories));

  const rows = await db
    .select({
      id: memoryEntries.id,
      profileScope: memoryEntries.profileScope,
      category: memoryEntries.category,
      title: memoryEntries.title,
      content: memoryEntries.content,
      status: memoryEntries.status,
      confidence: memoryEntries.confidence,
      manualEntry: memoryEntries.manualEntry,
      reasonText: memoryEntries.reasonText,
      approvedBy: memoryEntries.approvedBy,
      approvedAt: memoryEntries.approvedAt,
      createdAt: memoryEntries.createdAt,
      updatedAt: memoryEntries.updatedAt,
      sourceTaskId: memoryEntries.sourceTaskId,
      sourceTaskCode: tasks.code,
    })
    .from(memoryEntries)
    .leftJoin(tasks, eq(memoryEntries.sourceTaskId, tasks.id))
    .where(and(...whereClauses))
    .orderBy(desc(memoryEntries.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    profileScope: r.profileScope,
    category: r.category,
    title: r.title,
    content: r.content,
    status: r.status,
    confidence: r.confidence,
    sourceTaskCode: r.sourceTaskCode,
    sourceTaskId: r.sourceTaskId,
    manualEntry: r.manualEntry === 1,
    reasonText: r.reasonText,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function countPendingMemory(profile: ProfileFilter): Promise<number> {
  const scopes = scopeFilter(profile);
  const rows = await db
    .select({ id: memoryEntries.id })
    .from(memoryEntries)
    .where(
      and(
        inArray(memoryEntries.profileScope, scopes),
        eq(memoryEntries.status, "PROPOSED"),
      ),
    );
  return rows.length;
}
