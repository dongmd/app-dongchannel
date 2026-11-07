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
