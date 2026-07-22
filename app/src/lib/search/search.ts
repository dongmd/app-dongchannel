import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { ProfileFilter } from "@/lib/profiles/types";

// AC02 — Postgres FTS với 'simple' config (không stem, accent-agnostic đủ dùng cho VN+EN mix).
// V1: inline to_tsvector — không cần migration schema. Sẽ optimize thành GIN index ở DC-016.
// AC03 — ts_headline sinh snippet với <mark>...</mark> HTML tag; server-side dùng regex-strict tag.

export type SearchEntityType =
  | "task"
  | "memory"
  | "offer"
  | "video"
  | "niche"
  | "market"
  | "message";

export interface SearchItem {
  id: string;
  type: SearchEntityType;
  title: string;
  snippet: string; // may contain <mark>
  href: string;
  meta?: string; // e.g. "AFF · WATCHLIST"
  score: number;
}

export interface SearchGroup {
  type: SearchEntityType;
  label: string;
  items: SearchItem[];
}

export interface SearchInput {
  q: string;
  profile?: ProfileFilter;
  type?: SearchEntityType | "all";
  limitPerGroup?: number;
}

export interface SearchResult {
  query: string;
  totalMatched: number;
  groups: SearchGroup[];
}

const TYPE_LABEL: Record<SearchEntityType, string> = {
  task: "Nhiệm vụ",
  memory: "Trí nhớ",
  offer: "AFF Offer",
  video: "YouTube Video",
  niche: "YT Niche",
  market: "AFF Market",
  message: "Message Hermes",
};

const HEADLINE_OPTIONS =
  "StartSel=<mark>,StopSel=</mark>,MaxWords=25,MinWords=8,MaxFragments=2,FragmentDelimiter= … ";

// Trả plaintext q → an toàn với plainto_tsquery.
function sanitizeQuery(raw: string): string {
  return raw.trim().slice(0, 200);
}

async function searchTasks(q: string, profile: ProfileFilter, limit: number): Promise<SearchItem[]> {
  const scope = profile === "aff" ? ["aff"] : profile === "yt" ? ["yt"] : ["aff", "yt"];
  const rows = await db.execute<{
    id: string;
    code: string;
    title: string;
    profile_slug: string;
    status: string;
    snippet: string;
    score: number;
  }>(sql`
    SELECT id, code, title, profile_slug, status::text AS status,
      ts_headline('simple', title, plainto_tsquery('simple', ${q}), ${HEADLINE_OPTIONS}) AS snippet,
      ts_rank(to_tsvector('simple', title), plainto_tsquery('simple', ${q})) AS score
    FROM tasks
    WHERE to_tsvector('simple', title) @@ plainto_tsquery('simple', ${q})
      AND profile_slug = ANY(${sql.raw(`ARRAY[${scope.map((s) => `'${s}'`).join(",")}]`)}::text[])
    ORDER BY score DESC, updated_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    type: "task",
    title: `${r.code} · ${r.title}`,
    snippet: r.snippet || r.title,
    href: `/tasks/${r.id}`,
    meta: `${r.profile_slug.toUpperCase()} · ${r.status}`,
    score: Number(r.score),
  }));
}

async function searchMemory(q: string, profile: ProfileFilter, limit: number): Promise<SearchItem[]> {
  const scopes = profile === "aff" ? ["shared", "aff"] : profile === "yt" ? ["shared", "yt"] : ["shared", "aff", "yt"];
  const rows = await db.execute<{
    id: string;
    title: string;
    profile_scope: string;
    category: string;
    status: string;
    snippet: string;
    score: number;
  }>(sql`
    SELECT id, title, profile_scope::text AS profile_scope, category::text AS category, status::text AS status,
      ts_headline('simple', coalesce(title,'') || ' ' || coalesce(content,''), plainto_tsquery('simple', ${q}), ${HEADLINE_OPTIONS}) AS snippet,
      ts_rank(to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,'')), plainto_tsquery('simple', ${q})) AS score
    FROM memory_entries
    WHERE to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,'')) @@ plainto_tsquery('simple', ${q})
      AND profile_scope = ANY(${sql.raw(`ARRAY[${scopes.map((s) => `'${s}'`).join(",")}]`)}::text[])
    ORDER BY score DESC, created_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    type: "memory",
    title: r.title,
    snippet: r.snippet || r.title,
    href: `/memory?tab=${r.status === "PROPOSED" ? "pending" : r.category}`,
    meta: `${r.profile_scope} · ${r.status}`,
    score: Number(r.score),
  }));
}

async function searchOffers(q: string, limit: number): Promise<SearchItem[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    network: string | null;
    status: string;
    snippet: string;
    score: number;
  }>(sql`
    SELECT id, name, network, status::text AS status,
      ts_headline('simple', coalesce(name,'') || ' ' || coalesce(notes,''), plainto_tsquery('simple', ${q}), ${HEADLINE_OPTIONS}) AS snippet,
      ts_rank(to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(notes,'')), plainto_tsquery('simple', ${q})) AS score
    FROM offers
    WHERE to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(notes,'')) @@ plainto_tsquery('simple', ${q})
    ORDER BY score DESC, updated_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    type: "offer",
    title: r.name,
    snippet: r.snippet || r.name,
    href: `/aff/offers/${r.id}`,
    meta: [r.network, r.status].filter(Boolean).join(" · "),
    score: Number(r.score),
  }));
}

async function searchVideos(q: string, limit: number): Promise<SearchItem[]> {
  const rows = await db.execute<{
    id: string;
    working_title: string;
    title: string | null;
    status: string;
    snippet: string;
    score: number;
  }>(sql`
    SELECT id, working_title, title, status::text AS status,
      ts_headline('simple', coalesce(working_title,'') || ' ' || coalesce(title,'') || ' ' || coalesce(hook,'') || ' ' || coalesce(outline,''), plainto_tsquery('simple', ${q}), ${HEADLINE_OPTIONS}) AS snippet,
      ts_rank(to_tsvector('simple', coalesce(working_title,'') || ' ' || coalesce(title,'') || ' ' || coalesce(hook,'') || ' ' || coalesce(outline,'')), plainto_tsquery('simple', ${q})) AS score
    FROM videos
    WHERE to_tsvector('simple', coalesce(working_title,'') || ' ' || coalesce(title,'') || ' ' || coalesce(hook,'') || ' ' || coalesce(outline,'')) @@ plainto_tsquery('simple', ${q})
    ORDER BY score DESC, updated_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    type: "video",
    title: r.title ?? r.working_title,
    snippet: r.snippet || r.working_title,
    href: `/youtube/videos/${r.id}`,
    meta: `YT · ${r.status}`,
    score: Number(r.score),
  }));
}

async function searchNiches(q: string, limit: number): Promise<SearchItem[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    status: string;
    snippet: string;
    score: number;
  }>(sql`
    SELECT id, name, status::text AS status,
      ts_headline('simple', coalesce(name,'') || ' ' || coalesce(positioning,''), plainto_tsquery('simple', ${q}), ${HEADLINE_OPTIONS}) AS snippet,
      ts_rank(to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(positioning,'')), plainto_tsquery('simple', ${q})) AS score
    FROM niches
    WHERE to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(positioning,'')) @@ plainto_tsquery('simple', ${q})
    ORDER BY score DESC, updated_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    type: "niche",
    title: r.name,
    snippet: r.snippet || r.name,
    href: `/youtube/niches`,
    meta: r.status,
    score: Number(r.score),
  }));
}

async function searchMarkets(q: string, limit: number): Promise<SearchItem[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    status: string;
    snippet: string;
    score: number;
  }>(sql`
    SELECT id, name, status::text AS status,
      ts_headline('simple', coalesce(name,'') || ' ' || coalesce(summary,''), plainto_tsquery('simple', ${q}), ${HEADLINE_OPTIONS}) AS snippet,
      ts_rank(to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(summary,'')), plainto_tsquery('simple', ${q})) AS score
    FROM markets
    WHERE to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(summary,'')) @@ plainto_tsquery('simple', ${q})
    ORDER BY score DESC, updated_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    type: "market",
    title: r.name,
    snippet: r.snippet || r.name,
    href: `/aff/markets`,
    meta: r.status,
    score: Number(r.score),
  }));
}

async function searchMessages(q: string, limit: number): Promise<SearchItem[]> {
  // hermes_messages có thể rất nhiều rows — LIMIT + không JOIN sang task cho V1.
  const rows = await db.execute<{
    id: string;
    session_id: string;
    role: string;
    snippet: string;
    score: number;
  }>(sql`
    SELECT id, session_id, role,
      ts_headline('simple', coalesce(content,''), plainto_tsquery('simple', ${q}), ${HEADLINE_OPTIONS}) AS snippet,
      ts_rank(to_tsvector('simple', coalesce(content,'')), plainto_tsquery('simple', ${q})) AS score
    FROM hermes_messages
    WHERE to_tsvector('simple', coalesce(content,'')) @@ plainto_tsquery('simple', ${q})
    ORDER BY score DESC, occurred_at DESC NULLS LAST
    LIMIT ${limit}
  `);
  // Cần lookup task để có href tới /tasks/[taskId]. Query 1 lần theo session.
  if (rows.length === 0) return [];
  const sessionIds = Array.from(new Set(rows.map((r) => r.session_id)));
  const taskMap = new Map<string, string>();
  const taskRows = await db.execute<{ id: string; source_hermes_session_id: string }>(sql`
    SELECT id, source_hermes_session_id FROM tasks
    WHERE source_hermes_session_id = ANY(${sql.raw(`ARRAY[${sessionIds.map((s) => `'${s}'`).join(",")}]`)}::uuid[])
  `);
  for (const t of taskRows) taskMap.set(t.source_hermes_session_id, t.id);

  return rows.map((r) => {
    const taskId = taskMap.get(r.session_id);
    return {
      id: r.id,
      type: "message",
      title: `Message (${r.role})`,
      snippet: r.snippet,
      href: taskId ? `/tasks/${taskId}` : `/tasks`,
      meta: r.role,
      score: Number(r.score),
    };
  });
}

export async function unifiedSearch(input: SearchInput): Promise<SearchResult> {
  const q = sanitizeQuery(input.q);
  if (!q) return { query: "", totalMatched: 0, groups: [] };

  const profile = input.profile ?? "all";
  const limit = Math.max(3, Math.min(input.limitPerGroup ?? 5, 20));
  const type = input.type ?? "all";

  const results = await Promise.all([
    type === "all" || type === "task" ? searchTasks(q, profile, limit) : Promise.resolve([]),
    type === "all" || type === "memory" ? searchMemory(q, profile, limit) : Promise.resolve([]),
    type === "all" || type === "offer" ? searchOffers(q, limit) : Promise.resolve([]),
    type === "all" || type === "video" ? searchVideos(q, limit) : Promise.resolve([]),
    type === "all" || type === "niche" ? searchNiches(q, limit) : Promise.resolve([]),
    type === "all" || type === "market" ? searchMarkets(q, limit) : Promise.resolve([]),
    type === "all" || type === "message" ? searchMessages(q, limit) : Promise.resolve([]),
  ]);

  const [tasks, memory, offers, videos, niches, markets, messages] = results;
  const groups: SearchGroup[] = [];
  const push = (type: SearchEntityType, items: SearchItem[]) => {
    if (items.length > 0) groups.push({ type, label: TYPE_LABEL[type], items });
  };
  push("task", tasks);
  push("memory", memory);
  push("offer", offers);
  push("video", videos);
  push("niche", niches);
  push("market", markets);
  push("message", messages);

  const totalMatched = groups.reduce((n, g) => n + g.items.length, 0);
  return { query: q, totalMatched, groups };
}
