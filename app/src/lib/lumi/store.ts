import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import { applyAction, tick, type Action, type Result } from "./engine.ts";
import { createSeed, seedVideo } from "./seed.ts";
import type { DemoState } from "./types.ts";

// Kho dữ liệu demo: một file JSON trên đĩa (không Postgres). Mọi thao tác đi qua một hàng đợi
// trong tiến trình nên web và Telegram mô phỏng luôn thấy cùng một trạng thái.
const DIR = process.env.LUMI_PREVIEW_DATA_DIR ?? path.join(process.cwd(), ".preview-data");
const FILE = path.join(DIR, "lumi-demo.json");

const g = globalThis as unknown as { __lumiQueue?: Promise<unknown> };

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__lumiQueue ?? Promise.resolve()).then(fn, fn);
  g.__lumiQueue = run.catch(() => undefined);
  return run;
}

/** Dữ liệu demo lưu từ bản trước: bổ sung liên kết nguồn của quy tắc đề xuất. */
function migrate(s: DemoState): DemoState {
  // Bản trước chưa có video và số liệu quảng cáo: bổ sung và gắn các việc YouTube mẫu vào video demo.
  if (!Array.isArray(s.videos)) {
    s.videos = s.projects.some((p) => p.id === "p-yt") ? [seedVideo(Date.parse(s.resetAt) || Date.now())] : [];
    for (const t of s.tasks) if ((t.id === "DL-003" || t.id === "DL-005") && t.projectId === "p-yt") t.videoId = "v-1";
  }
  if (!Array.isArray(s.adResults)) s.adResults = [];
  for (const t of s.tasks) {
    if (t.source.kind === "telegram" && !t.source.chat) {
      const chat = /YouTube/i.test(t.source.label) ? "yt" : "aff";
      t.source.chat = chat;
      t.source.botName = s.members.find((m) => m.profileKey === chat)?.name ?? "Bot";
    }
  }
  for (const m of s.memories) {
    if (m.kind === "rule" && !m.sourceMemoryId) {
      if (m.id === "mem-p1") m.sourceMemoryId = "mem-d1";
      if (m.id === "mem-p2") m.sourceMemoryId = "mem-d2";
    }
  }
  return s;
}

async function load(): Promise<DemoState> {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8")) as DemoState;
    if (parsed.schema === 1 && Array.isArray(parsed.members)) return migrate(parsed);
  } catch {
    // chưa có file hoặc file hỏng: dựng lại từ dữ liệu mẫu
  }
  return createSeed(Date.now());
}

async function save(s: DemoState): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s), "utf8");
  await fs.rename(tmp, FILE);
}

async function persistIfChanged(before: string, s: DemoState, rev0: number): Promise<void> {
  const after = JSON.stringify(s);
  if (after === before) return;
  if (s.rev === rev0) s.rev = rev0 + 1;
  await save(s);
}

export function readState(): Promise<DemoState> {
  return locked(async () => {
    const s = await load();
    const before = JSON.stringify(s);
    tick(s, Date.now());
    await persistIfChanged(before, s, s.rev);
    return s;
  });
}

export function mutate(action: Action): Promise<{ result: Result; state: DemoState }> {
  return locked(async () => {
    const s = await load();
    const before = JSON.stringify(s);
    const rev0 = s.rev;
    tick(s, Date.now());
    const result = applyAction(s, action, Date.now());
    await persistIfChanged(before, s, rev0);
    return { result, state: s };
  });
}

export function resetState(): Promise<DemoState> {
  return locked(async () => {
    const prev = await load();
    const s = createSeed(Date.now());
    s.rev = prev.rev + 1;
    await save(s);
    return s;
  });
}
