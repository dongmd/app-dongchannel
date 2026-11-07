/**
 * IMP-03 / OFC-03: the execution level the OWNER grants an assistant. A level is an upper bound on the TOOLS its allowlist may contain and on what it may start
 * by itself; it is stored in the existing `lumi_assistants.execution_level` column (no new enum). Default = the lowest. Q-labels of ORG-04 stay derived.
 */
export const EXEC_LEVELS = [
  { level: 0, label: "Chỉ đề xuất", tools: ["knowledge.context", "outputs.submit", "plan.submit.version", "tasks.intake"], internal: false,
    note: "Đọc việc được giao, nộp đầu ra/kế hoạch để Chủ duyệt, tạo bản nháp giao việc. Không tự bàn giao hay làm việc con." },
  { level: 1, label: "Soạn đầu ra + công cụ đọc", tools: ["knowledge.context", "outputs.submit", "plan.submit.version", "tasks.intake", "web", "skills"], internal: false,
    note: "Thêm đọc web và đọc skill (chỉ đọc)." },
  { level: 2, label: "Hành động nội bộ", tools: ["knowledge.context", "outputs.submit", "plan.submit.version", "tasks.intake", "web", "skills"], internal: true,
    note: "Được khởi tạo bàn giao giữa bot và đề xuất trong phạm vi chính sách; vẫn không có quyền hành động bên ngoài (đó là giấy ủy quyền)." },
  { level: 3, label: "Do Chủ chỉ định (công cụ rộng)", tools: [] as string[], internal: true,
    note: "Dành cho chế độ công cụ rộng DECLARED_FULL do Chủ khai báo và xác nhận." },
] as const;

export const MAX_LEVEL = 3;
export const levelOf = (n: number) => EXEC_LEVELS[Math.max(0, Math.min(MAX_LEVEL, n))]!;

/** Tools of an allowlist that the level does not cover (empty = within the level). Level 3 only fits DECLARED_FULL assistants. */
export function toolsAboveLevel(level: number, allowlist: string[], capabilityMode: string): string[] {
  if (level >= 3 && capabilityMode === "DECLARED_FULL") return [];
  const allowed = levelOf(level).tools as readonly string[];
  return allowlist.filter((t) => !allowed.includes(t));
}
export const canInitiateInternal = (level: number) => levelOf(level).internal;
