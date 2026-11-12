import { test } from "node:test";
import assert from "node:assert/strict";

import { deskSpots, MEET_ID, planOffice, ROOM_GAP, ROOM_W, type PlanMember, type PlanProject } from "./office-layout.ts";
import { meetingBoard, seatedMemberIds } from "./office-state.ts";

const P = (id: string, status: "active" | "archived" = "active"): PlanProject => ({ id, name: `Dự án ${id}`, area: "Affiliate", status });
const B = (id: string, ...projectIds: string[]): PlanMember => ({ id, kind: "bot", projectIds });
const H: PlanMember = { id: "m-owner", kind: "human", projectIds: [] };

test("Văn phòng v2: Chủ và trợ lý chưa gắn dự án vào Điều hành; trợ lý vào phòng dự án đang chạy đầu tiên", () => {
  const plan = planOffice([H, B("a", "p1"), B("b", "px", "p2"), B("c")], [P("p1"), P("p2"), P("px", "archived")]);
  const room = (id: string) => plan.rooms.find((r) => r.id === id)!;
  assert.deepEqual(room("ops").desks.map((d) => d.memberId).sort(), ["c", "m-owner"]);
  assert.deepEqual(room("p:p1").desks.map((d) => d.memberId), ["a"]);
  assert.deepEqual(room("p:p2").desks.map((d) => d.memberId), ["b"]); // dự án đã lưu trữ không có phòng
  assert.equal(plan.rooms.some((r) => r.id === "p:px"), false);
});

test("Văn phòng v2: Phòng họp trải hai cột ở hàng giữa, số phòng luôn chẵn, mỗi thành viên đúng một bàn", () => {
  for (const nProj of [0, 1, 2, 3, 4, 7]) {
    const projects = Array.from({ length: nProj }, (_, i) => P(`p${i}`));
    const members = [H, ...projects.map((p, i) => B(`b${i}`, p.id)), B("loose")];
    const plan = planOffice(members, projects);
    const meet = plan.rooms.find((r) => r.id === MEET_ID)!;
    assert.equal(meet.span, 2);
    assert.equal(meet.row, 1);
    assert.equal(meet.w, 2 * ROOM_W + ROOM_GAP);
    const others = plan.rooms.filter((r) => r.id !== MEET_ID);
    assert.equal(others.length % 2, 0, `nProj=${nProj}`);
    const seats = others.flatMap((r) => r.desks.map((d) => d.memberId)).sort();
    assert.deepEqual(seats, members.map((m) => m.id).sort());
  }
});

test("Văn phòng v2: các phòng không chồng nhau, nằm trong khung và phòng đông người sâu hơn", () => {
  const projects = [P("p1"), P("p2"), P("p3")];
  const members = [H, ...["a", "b", "c", "d", "e"].map((id) => B(id, "p1")), B("f", "p2")];
  const plan = planOffice(members, projects);
  for (const a of plan.rooms) {
    assert.ok(Math.abs(a.x) + a.w / 2 <= plan.width / 2 + 1e-9);
    assert.ok(Math.abs(a.z) + a.d / 2 <= plan.depth / 2 + 1e-9);
    for (const b of plan.rooms) {
      if (a === b) continue;
      const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-9;
      const overlapZ = Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 1e-9;
      assert.equal(overlapX && overlapZ, false, `${a.id} chồng ${b.id}`);
    }
  }
  const crowded = plan.rooms.find((r) => r.id === "p:p1")!;
  assert.equal(crowded.desks.length, 5);
  assert.ok(crowded.d > 6); // 3 hàng bàn
  for (const r of plan.rooms) for (const d of r.desks) assert.ok(Math.abs(d.x) + 1.15 <= r.w / 2 && Math.abs(d.z) + 1.7 <= r.d / 2, `bàn ${d.memberId} lọt ra ngoài phòng ${r.id}`);
});

test("Văn phòng v2: bàn trong phòng cách nhau đủ để không chồng nhãn", () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const { desks } = deskSpots(Array.from({ length: n }, (_, i) => `m${i}`));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(Math.abs(desks[i]!.x - desks[j]!.x) >= 3.8 || Math.abs(desks[i]!.z - desks[j]!.z) >= 3.4, `n=${n}`);
  }
});

test("Bảng họp: chưa có dữ liệu khác với không có cuộc họp; gom đúng ba cột", () => {
  assert.equal(meetingBoard(null).columns.every((c) => c.count === 0), true);
  const rows = [
    { code: "MT-3", title: "Dự toán", state: "OPEN", outcome: "PENDING", contributions: 1, pending_owner: 0 },
    { code: "MT-2", title: "Mốc thử nghiệm", state: "CLOSED", outcome: "DECIDED", contributions: 3, pending_owner: 2 },
    { code: "MT-1", title: "Cũ", state: "CLOSED", outcome: "NO_DECISION", contributions: 0, pending_owner: 0 },
  ];
  const b = meetingBoard(rows);
  assert.equal(b.open.length, 1);
  assert.deepEqual(b.pendingOwner, [{ code: "MT-2", title: "Mốc thử nghiệm", n: 2 }]);
  assert.equal(b.columns[1]!.count, 2);
  assert.equal(b.recent.length, 2);
});

test("Bàn họp: người tham dự khớp thành viên theo slug; Chủ và người không slug là Chủ", () => {
  const ids = seatedMemberIds([{ slug: "aff", role: "CHAIR" }, { slug: "yt", role: "CONTRIBUTOR" }, { slug: null, role: "OWNER_OPTIONAL" }, { slug: "aff", role: "OBSERVER" }], "m-owner");
  assert.deepEqual(ids, ["bot-aff", "bot-yt", "m-owner"]);
});
