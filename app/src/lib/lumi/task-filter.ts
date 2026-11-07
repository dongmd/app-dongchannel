/**
 * IMP-02 / PRJ-06: cross-project task list. Pure functions over the SAME state the Dashboard reads, so the counts of one scope agree
 * (the Dashboard's `openTasks(s, {projectId, memberId})` is exactly the `status: "open"` result here).
 */
import { openTasks } from "./selectors";
import { TASK_STATUSES, type DemoState, type Task, type TaskStatus } from "./types";

export interface TaskFilter {
  projectId?: string; ownerId?: string;
  /** a UI status, "open" (everything not done — what the Dashboard counts), or undefined/"all" */
  status?: TaskStatus | "open" | "all";
  /** the real PostgreSQL status (db mode), e.g. FAILED, REJECTED, WAITING_ASSISTANT */
  realStatus?: string;
  source?: "web" | "telegram";
  due?: "overdue" | "has" | "none";
  q?: string;
}

export const normalizeText = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

export function filterTasks(s: DemoState, f: TaskFilter, nowMs: number): Task[] {
  const q = f.q?.trim() ? normalizeText(f.q.trim()) : "";
  const pname = (id: string) => s.projects.find((p) => p.id === id)?.name ?? "";
  const base = f.status === "open" ? openTasks(s, { projectId: f.projectId, memberId: f.ownerId }) : [...s.tasks];
  return base.filter((t) => {
    if (f.projectId && t.projectId !== f.projectId) return false;
    if (f.ownerId && t.ownerId !== f.ownerId) return false;
    if (f.status && f.status !== "all" && f.status !== "open" && t.status !== f.status) return false;
    if (f.realStatus && t.real?.status !== f.realStatus) return false;
    if (f.source && t.source.kind !== f.source) return false;
    if (f.due === "has" && !t.due) return false;
    if (f.due === "none" && t.due) return false;
    if (f.due === "overdue" && !(t.due && Date.parse(t.due) < nowMs && t.status !== "done")) return false;
    if (q) {
      const hay = normalizeText([t.id, t.title, t.request, t.outputWanted, t.ownerName, pname(t.projectId)].join(" "));
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function statusCounts(tasks: Task[]): Record<TaskStatus, number> & { total: number } {
  const c = { total: tasks.length } as Record<TaskStatus, number> & { total: number };
  for (const k of TASK_STATUSES) c[k] = 0;
  for (const t of tasks) c[t.status] += 1;
  return c;
}
