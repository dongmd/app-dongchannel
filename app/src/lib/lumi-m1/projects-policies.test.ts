/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-02 (PRJ-01, CMP-03) — evidence class A: PGlite + the real migrations (incl. 0045). No model, no Hermes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { createTask } from "./core-web";
import { decideProposal } from "./autonomy";
import { createAssistant } from "./assistants";
import { archiveProject, createProject, slugify, updateProject, validateProjectInput } from "./projects";
import { getPolicy, listPolicies, requirePolicy, setPolicy, validatePolicyValue } from "./policies";

const T0 = new Date("2026-11-07T08:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };

async function world() {
  const { db } = await freshDb();
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  return { db };
}

describe("IMP-02 dự án (PRJ-01) — lớp A", () => {
  it("1. slug bỏ dấu tiếng Việt; kiểm hợp lệ; chỉ OWNER ghi", async () => {
    assert.equal(slugify("Dự án Mới Đẹp!"), "du-an-moi-dep");
    assert.equal(slugify("!!"), "du-an");
    assert.deepEqual(validateProjectInput({ name: "ab", area: "KHAC", pmActorRef: "x", pmAssistantId: "y" }, false).map((s) => s.split("(")[0]), ["name", "area", "pm"]);
    const w = await world();
    for (const who of [ADMIN, VIEWER]) await rejects(createProject(w.db, { actorRef: who, key: "proj-key-0001", input: { name: "Dự án A", area: "AFFILIATE" }, now: T0 }), "FORBIDDEN");
  });

  it("2. tạo: nhấn đôi cùng khóa một dự án; tên trùng (không phân biệt hoa thường) bị chặn; trùng slug thêm hậu tố; thành viên + PM", async () => {
    const w = await world();
    const asst = (await createAssistant(w.db, { actorRef: OWNER, key: "asst-key-0001", input: { slug: "bot-a", name: "Bot A", roleLabel: "Nghiên cứu", toolAllowlist: ["knowledge.context", "outputs.submit"], limits: { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 2, maxRunsPerDay: 10 } }, now: T0 })).assistant;
    const a = await createProject(w.db, { actorRef: OWNER, key: "proj-key-0001", input: { name: "Dự án Mới", area: "AFFILIATE", goal: "Mục tiêu thử", pmAssistantId: asst.id, memberIds: [asst.id] }, now: T0 });
    assert.equal(a.project.slug, "du-an-moi"); assert.equal(a.project.status, "ACTIVE");
    const again = await createProject(w.db, { actorRef: OWNER, key: "proj-key-0001", input: { name: "Dự án Mới", area: "AFFILIATE" }, now: at(5) });
    assert.equal(again.alreadyProcessed, true);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_projects`)).length, 1);
    await rejects(createProject(w.db, { actorRef: OWNER, key: "proj-key-0002", input: { name: "DỰ ÁN MỚI", area: "YOUTUBE" }, now: T0 }), "NAME_TAKEN");
    const c = await createProject(w.db, { actorRef: OWNER, key: "proj-key-0003", input: { name: "Du an moi!", area: "OTHER" }, now: T0 }); // distinct name, same slug
    assert.equal(c.project.slug, "du-an-moi-2");
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_project_members WHERE project_id=$1`, [a.project.id])).length, 1);
    await rejects(createProject(w.db, { actorRef: OWNER, key: "proj-key-0004", input: { name: "Dự án D", area: "OTHER", memberIds: ["00000000-0000-4000-8000-000000000000"] }, now: T0 }), "NOT_FOUND");
  });

  it("3. sửa đổi tên/mục tiêu/PM; lưu trữ chỉ khi không còn việc mở/kế hoạch/mục tiêu; lưu trữ lặp an toàn; dự án đã lưu trữ không sửa được", async () => {
    const w = await world();
    const p = (await createProject(w.db, { actorRef: OWNER, key: "proj-key-0010", input: { name: "Dự án X", area: "AFFILIATE" }, now: T0 })).project;
    const u = await updateProject(w.db, { actorRef: OWNER, id: p.id, patch: { name: "Dự án X2", goal: "Mới", pmActorRef: OWNER }, now: at(1) });
    assert.deepEqual([u.project.name, u.project.goal, u.project.pm_actor_ref], ["Dự án X2", "Mới", OWNER]);
    const other = (await createProject(w.db, { actorRef: OWNER, key: "proj-key-0011", input: { name: "Dự án Y", area: "OTHER" }, now: T0 })).project;
    await rejects(updateProject(w.db, { actorRef: OWNER, id: other.id, patch: { name: "dự án x2" }, now: at(2) }), "NAME_TAKEN");
    // an open task blocks the archive
    const a = (await createAssistant(w.db, { actorRef: OWNER, key: "asst-key-0010", input: { slug: "bot-b", name: "Bot B", roleLabel: "Viết", toolAllowlist: ["outputs.submit"], limits: { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 2, maxRunsPerDay: 10 } }, now: T0 })).assistant;
    const t = (await createTask(w.db, { actorRef: OWNER, clientRequestId: "proj-task-0001", projectId: p.id, assigneeId: a.id, title: "Việc mở", now: at(3) })).task;
    await rejects(archiveProject(w.db, { actorRef: OWNER, id: p.id, now: at(4) }), "PROJECT_BUSY");
    await w.db.query(`UPDATE tasks SET status='COMPLETED' WHERE id=$1`, [t.id]);
    const r = await archiveProject(w.db, { actorRef: OWNER, id: p.id, now: at(5) });
    assert.equal(r.project.status, "ARCHIVED");
    assert.equal((await archiveProject(w.db, { actorRef: OWNER, id: p.id, now: at(6) })).alreadyProcessed, true);
    await rejects(updateProject(w.db, { actorRef: OWNER, id: p.id, patch: { goal: "x" }, now: at(7) }), "INVALID_TRANSITION");
    await rejects(archiveProject(w.db, { actorRef: VIEWER, id: other.id, now: at(8) }), "FORBIDDEN");
  });
});

describe("IMP-02 chính sách Chủ đặt, có phiên bản, không mặc định (CMP-03) — lớp A", () => {
  it("4. mỗi khóa có lược đồ riêng; sai thì liệt kê lỗi; 'bỏ đặt' (null) luôn hợp lệ", () => {
    assert.deepEqual(validatePolicyValue("prepare_fund", { amount: 20, currency: "USD" }), []);
    assert.ok(validatePolicyValue("prepare_fund", { amount: -1, currency: "usd" }).length === 2);
    assert.ok(validatePolicyValue("owner_hourly_rate", { amount: 0, currency: "USD" }).length === 1);
    assert.ok(validatePolicyValue("report_cadence_days", 0).length === 1 && validatePolicyValue("report_cadence_days", 7).length === 0);
    assert.ok(validatePolicyValue("meeting_cap", 3.5).length === 1 && validatePolicyValue("meeting_cap", 0).length === 0);
    assert.ok(validatePolicyValue("currency", "usd").length === 1 && validatePolicyValue("currency", "USD").length === 0);
    for (const k of ["prepare_fund", "max_loss", "currency", "meeting_cap"] as const) assert.deepEqual(validatePolicyValue(k, null), []);
  });

  it("5. chưa đặt ⇒ bước cần nó bị chặn kèm lý do cụ thể; đặt ⇒ phiên bản 1; giá trị y hệt không tạo phiên bản; đổi ⇒ phiên bản 2; lịch sử còn; bỏ đặt ⇒ chặn lại", async () => {
    const w = await world();
    await assert.rejects(requirePolicy(w.db, "prepare_fund"), (e: any) => e.code === "POLICY_NOT_SET" && e.data.key === "prepare_fund" && /quỹ chuẩn bị/.test(e.data.label));
    assert.equal(await getPolicy(w.db, "prepare_fund"), null, "không có giá trị mặc định");
    const a = await setPolicy(w.db, { actorRef: OWNER, key: "prepare_fund", value: { amount: 20, currency: "USD" }, note: "vòng thử đầu", now: at(1) });
    assert.deepEqual([a.version, a.alreadyProcessed], [1, false]);
    assert.equal((await setPolicy(w.db, { actorRef: OWNER, key: "prepare_fund", value: { amount: 20, currency: "USD" }, now: at(2) })).alreadyProcessed, true);
    assert.equal((await setPolicy(w.db, { actorRef: OWNER, key: "prepare_fund", value: { amount: 30, currency: "USD" }, now: at(3) })).version, 2);
    assert.equal(Number((await requirePolicy(w.db, "prepare_fund")).value.amount), 30);
    const h = await listPolicies(w.db);
    assert.deepEqual(h.history.map((x: any) => x.version), [2, 1]); assert.equal(h.current.length, 1);
    assert.equal((await setPolicy(w.db, { actorRef: OWNER, key: "prepare_fund", value: null, now: at(4) })).version, 3);
    assert.equal((await listPolicies(w.db)).current.length, 0);
    await assert.rejects(requirePolicy(w.db, "prepare_fund"), (e: any) => e.code === "POLICY_NOT_SET");
    // theo phạm vi: chính sách của bot khác không thay thế chính sách công ty
    await setPolicy(w.db, { actorRef: OWNER, key: "report_cadence_days", scope: "assistant:bot-a", value: 7, now: at(5) });
    assert.equal(await getPolicy(w.db, "report_cadence_days"), null);
    assert.equal(Number((await getPolicy(w.db, "report_cadence_days", "assistant:bot-a"))!.value), 7);
  });

  it("6. chỉ OWNER đặt; khóa/phạm vi/giá trị sai bị từ chối; bảng chỉ-thêm (trigger chặn sửa/xóa)", async () => {
    const w = await world();
    for (const who of [ADMIN, VIEWER]) await rejects(setPolicy(w.db, { actorRef: who, key: "currency", value: "USD", now: T0 }), "FORBIDDEN");
    await rejects(setPolicy(w.db, { actorRef: OWNER, key: "tuy_y", value: 1, now: T0 }), "VALIDATION_ERROR");
    await rejects(setPolicy(w.db, { actorRef: OWNER, key: "currency", scope: "zzz", value: "USD", now: T0 }), "VALIDATION_ERROR");
    await rejects(setPolicy(w.db, { actorRef: OWNER, key: "currency", value: "dola", now: T0 }), "VALIDATION_ERROR");
    await setPolicy(w.db, { actorRef: OWNER, key: "currency", value: "USD", now: T0 });
    await assert.rejects(() => w.db.query(`UPDATE lumi_policies SET value='"VND"'::jsonb`), /chỉ-thêm/);
    await assert.rejects(() => w.db.query(`DELETE FROM lumi_policies`), /chỉ-thêm/);
  });

  it("7. người tiêu thụ thứ nhất: hạn đề xuất dự án — chưa đặt ⇒ không hết hạn (hệ thống không tự bịa số); đã đặt ⇒ đề xuất quá hạn không kích hoạt được", async () => {
    const w = await world();
    const mkProposal = async (slug: string, ageDays: number) => (await w.db.query<any>(
      `INSERT INTO lumi_projects(slug,name,area,status,created_at) VALUES ($1,$2,'AFFILIATE','PROPOSED',$3) RETURNING id`, [slug, `Đề xuất ${slug}`, new Date(T0.getTime() - ageDays * 86400_000).toISOString()]))[0].id as string;
    const old = await mkProposal("de-xuat-cu", 40);
    assert.equal((await decideProposal(w.db, OWNER, old, "ACTIVATE", T0)).alreadyProcessed, false); // no policy ⇒ no expiry
    await setPolicy(w.db, { actorRef: OWNER, key: "proposal_ttl_days", value: 14, now: T0 });
    const old2 = await mkProposal("de-xuat-cu-2", 40); const fresh = await mkProposal("de-xuat-moi", 3);
    await assert.rejects(decideProposal(w.db, OWNER, old2, "ACTIVATE", T0), (e: any) => e.code === "GONE" && e.data.ttl_days === 14);
    assert.equal((await decideProposal(w.db, OWNER, fresh, "ACTIVATE", T0)).alreadyProcessed, false);
    assert.equal((await decideProposal(w.db, OWNER, old2, "REJECT", T0)).alreadyProcessed, false); // rejecting an expired proposal is still allowed
  });
});
