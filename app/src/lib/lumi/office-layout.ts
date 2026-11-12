// Bố trí các góc làm việc trong Văn phòng 3D (hàm thuần, kiểm thử được không cần WebGL).

export const DX = 4.1; // khoảng cách ngang giữa hai góc làm việc
export const DZ = 4.3; // khoảng cách sâu giữa hai hàng
export const LABEL_WIDTH = 1.6; // bề rộng nhãn tên (đơn vị cảnh)

/** Số góc làm việc mỗi hàng: 2 cột cho ≤4 thành viên (căn phòng gần vuông), 3 cột cho nhiều hơn. */
export const colsFor = (n: number) => (n <= 4 ? 2 : 3);

/** Tên ngắn trên nhãn: bỏ tiền tố "Trợ lý ", tối đa 12 ký tự. */
export function shortName(name: string): string {
  const n = name.replace(/^Trợ lý\s+/i, "").trim() || name;
  return n.length > 12 ? `${n.slice(0, 11)}…` : n;
}

/** Vị trí các góc làm việc: lưới theo `colsFor`, hàng cuối canh giữa. */
export function layoutSpots(n: number): { x: number; z: number }[] {
  const COLS = colsFor(n);
  const rows = Math.max(1, Math.ceil(n / COLS));
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    const inRow = Math.min(COLS, n - r * COLS);
    return { x: (c - (inRow - 1) / 2) * DX, z: (r - (rows - 1) / 2) * DZ };
  });
}

// ───────────────────────── Văn phòng v2 (OFC-07): phòng theo dự án + Phòng họp ─────────────────────────
// Hàm thuần: nhận thành viên và dự án, trả sơ đồ phòng dùng chung cho 2D và 3D (một nguồn bố cục, OFC-01).

export const ROOM_W = 7; // bề rộng một phòng (đơn vị cảnh)
export const ROOM_GAP = 1.2; // khe giữa hai phòng
export const ROOM_D = 6; // chiều sâu tối thiểu của một phòng
export const DESK_ROW = 3.4; // khoảng cách giữa hai hàng bàn trong cùng một phòng
export const MEET_ID = "meet";
export const OPS_ID = "ops";

export type RoomKind = "ops" | "project" | "meet" | "free";

export interface PlanMember {
  id: string;
  kind: "human" | "bot";
  projectIds: string[];
}
export interface PlanProject {
  id: string;
  name: string;
  area: string;
  status: "active" | "archived";
}
export interface DeskSpot {
  memberId: string;
  x: number; // vị trí bàn trong phòng, gốc là tâm phòng
  z: number;
}
export interface RoomPlan {
  id: string;
  kind: RoomKind;
  name: string;
  sub: string;
  accent: string;
  /** Hàng và cột trong lưới 2 cột; phòng họp chiếm cả hai cột. */
  row: number;
  col: number;
  span: 1 | 2;
  /** Tâm phòng trong cảnh (gốc là tâm toàn văn phòng) và kích thước. */
  x: number;
  z: number;
  w: number;
  d: number;
  desks: DeskSpot[];
}
export interface OfficePlan {
  rooms: RoomPlan[];
  width: number;
  depth: number;
}

const OPS_ACCENT = "#f5b84a";
const MEET_ACCENT = "#e8e3d4";
const FREE_ACCENT = "#59627a";
const PROJECT_ACCENTS = ["#3fc1c9", "#8f7cf0", "#e0614f", "#6fbf8a", "#d98fd0", "#e0b44a"];

/** Bàn trong một phòng: tối đa 2 bàn mỗi hàng, hàng cuối canh giữa; tâm khối bàn nằm hơi lùi về phía vách sau. */
export function deskSpots(memberIds: string[]): { desks: DeskSpot[]; d: number } {
  const n = memberIds.length;
  const rows = Math.max(1, Math.ceil(n / 2));
  const desks = memberIds.map((memberId, i) => {
    const r = Math.floor(i / 2);
    const inRow = Math.min(2, n - r * 2);
    const c = i % 2;
    return { memberId, x: inRow === 1 ? 0 : c === 0 ? -1.9 : 1.9, z: -0.3 + (r - (rows - 1) / 2) * DESK_ROW };
  });
  return { desks, d: ROOM_D + (rows - 1) * DESK_ROW };
}

/**
 * Sơ đồ văn phòng. Phòng "Điều hành" (Chủ và trợ lý chưa gắn dự án) + mỗi dự án đang chạy một phòng; phòng họp trải hai cột ở giữa.
 * Số phòng lẻ thì thêm một phòng trống ("Thêm trợ lý"). Trợ lý vào phòng của dự án đang chạy đầu tiên trong `projectIds` của họ.
 */
export function planOffice(members: PlanMember[], projects: PlanProject[]): OfficePlan {
  const active = projects.filter((p) => p.status === "active");
  const byProject = new Map<string, string[]>(active.map((p) => [p.id, []]));
  const ops: string[] = [];
  for (const m of members) {
    const home = m.kind === "human" ? undefined : m.projectIds.find((id) => byProject.has(id));
    if (home) byProject.get(home)!.push(m.id);
    else ops.push(m.id);
  }
  type Slot = { id: string; kind: RoomKind; name: string; sub: string; accent: string; ids: string[] };
  const slots: Slot[] = [{ id: OPS_ID, kind: "ops", name: "Điều hành", sub: "Chủ hệ thống và trợ lý chưa gắn dự án", accent: OPS_ACCENT, ids: ops }];
  active.forEach((p, i) => slots.push({ id: `p:${p.id}`, kind: "project", name: p.name, sub: p.area, accent: PROJECT_ACCENTS[i % PROJECT_ACCENTS.length]!, ids: byProject.get(p.id)! }));
  if (slots.length % 2 === 1) slots.push({ id: "free", kind: "free", name: "Phòng trống", sub: "Chưa có trợ lý", accent: FREE_ACCENT, ids: [] });

  // Hàng 0: hai phòng đầu; hàng 1: phòng họp; các hàng sau: từng cặp phòng.
  const rows: (Slot | "meet")[][] = [slots.slice(0, 2), ["meet"]];
  for (let i = 2; i < slots.length; i += 2) rows.push(slots.slice(i, i + 2));

  const planned = rows.map((row) =>
    row.map((s) => {
      if (s === "meet") return { s, desks: [] as DeskSpot[], d: ROOM_D };
      const { desks, d } = deskSpots(s.ids);
      return { s, desks, d };
    }),
  );
  const rowDepth = planned.map((r) => Math.max(...r.map((x) => x.d)));
  const depth = rowDepth.reduce((a, b) => a + b, 0) + ROOM_GAP * (rows.length - 1);
  const width = 2 * ROOM_W + ROOM_GAP;
  const rooms: RoomPlan[] = [];
  let top = -depth / 2;
  planned.forEach((row, r) => {
    const z = top + rowDepth[r]! / 2;
    row.forEach((x, c) => {
      if (x.s === "meet") {
        rooms.push({ id: MEET_ID, kind: "meet", name: "Phòng họp", sub: "Họp bất đồng bộ có lý do", accent: MEET_ACCENT, row: r, col: 0, span: 2, x: 0, z, w: width, d: rowDepth[r]!, desks: [] });
      } else {
        rooms.push({ id: x.s.id, kind: x.s.kind, name: x.s.name, sub: x.s.sub, accent: x.s.accent, row: r, col: c, span: 1, x: (c - 0.5) * (ROOM_W + ROOM_GAP), z, w: ROOM_W, d: rowDepth[r]!, desks: x.desks });
      }
    });
    top += rowDepth[r]! + ROOM_GAP;
  });
  return { rooms, width, depth };
}
