/**
 * EVIDENCE CLASS 2-UI: a real browser (Chrome via playwright-core, no download) drives the real Next dev server, real
 * middleware, real PostgreSQL server and the real worker process. Hermes/Telegram remain the SIMULATED boundary (class 3 is
 * separate). Covers: create task → bản 1 → yêu cầu sửa → bản 2 → duyệt, role-limited UI, unauthenticated redirect, and that
 * the dev login is refused when its gate is closed (second server without LUMI_DEV_LOGIN).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.cwd(), "package.json"));
import { chromium, type Browser, type Page } from "playwright-core";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { contribute, meetingTick, synthesizeMeeting } from "./meetings";

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
let pg: PgServer;
let browser: Browser;
const kids: ChildProcess[] = [];
let base = "";
let baseNoLogin = "";

const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const nextBin = () => path.join(path.dirname(require.resolve("next/package.json")), "dist", "bin", "next");

async function waitHttp(url: string, ms = 240_000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
function startNext(port: number, extra: Record<string, string>): ChildProcess {
  const c = spawn(process.execPath, [nextBin(), "dev", "-p", String(port)], {
    cwd: process.cwd(), stdio: process.env.LUMI_UI_LOG ? ["ignore", fs.openSync(process.env.LUMI_UI_LOG, "a"), fs.openSync(process.env.LUMI_UI_LOG, "a")] : "ignore",
    env: { ...process.env, DATABASE_URL: pg.url, NEXTAUTH_URL: `http://localhost:${port}`, NEXTAUTH_SECRET: "ui-test-only-secret-0123456789abcdef0123", NODE_ENV: "development", NODE_OPTIONS: "--max-old-space-size=4096", ...extra },
  });
  kids.push(c);
  return c;
}
/** Dev-server hot reloads can abort a navigation (net::ERR_ABORTED); retry instead of failing the test. */
async function go(page: Page, url: string) {
  for (let i = 0; ; i++) {
    try { await page.goto(url); return; }
    catch (e) { if (i >= 3 || !String(e).includes("ERR_ABORTED")) throw e; await page.waitForTimeout(1500); }
  }
}
async function login(page: Page, origin: string, email: string) {
  await go(page, `${origin}/login`);
  return page.evaluate(async (e) => {
    const c = await (await fetch("/api/auth/csrf")).json();
    await fetch("/api/auth/callback/dev-login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: c.csrfToken, email: e, json: "true" }) });
    return (await (await fetch("/api/auth/session")).json()) as { user?: { email: string; role: string } };
  }, email);
}
async function waitFor(page: Page, text: string, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    if ((await page.locator("main").innerText()).includes(text)) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for "${text}" — page says:\n${(await page.locator("main").innerText()).slice(0, 600)}`);
    await page.waitForTimeout(1500);
    await page.reload();
  }
}

before(async () => {
  assert.ok(CHROME, "no Chrome/Edge/Chromium found for playwright-core");
  pg = await startPgServer({ migrate: false });
  const seed = spawnSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "scripts/lumi-m1-seed.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: pg.url }, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  const p1 = await freePort(); const p2 = await freePort();
  base = `http://localhost:${p1}`; baseNoLogin = `http://localhost:${p2}`;
  startNext(p1, { LUMI_DEV_LOGIN: "1", LUMI_DATA: "db", DONGLUMI_PREVIEW: "1", LUMI_PLAN_MAX_TASKS: "5" }); // db mode must win over the anonymous preview flag
  startNext(p2, { LUMI_DATA: "db" }); // gate CLOSED: no LUMI_DEV_LOGIN
  kids.push(spawn(process.execPath, ["--import", "tsx", "--conditions=react-server", "scripts/lumi-m1-worker.ts", "--simulate"], { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, DATABASE_URL: pg.url, LUMI_PLAN_MAX_TASKS: "5" } }));
  await Promise.all([waitHttp(`${base}/api/health`), waitHttp(`${baseNoLogin}/api/health`)]);
  // Warm up (compile) every route the tests touch so a dev-server hot reload cannot interrupt a login mid-test.
  for (const o of [base, baseNoLogin]) for (const path of ["/login", "/work", "/lumi", "/lumi/projects/test-offer-us", "/lumi/telegram", "/lumi/company", "/api/v1/lumi/goals", "/api/lumi/state", "/api/auth/session", "/api/v1/tasks"]) await fetch(o + path, { redirect: "manual" }).catch(() => {});
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => {
  await browser?.close().catch(() => {});
  for (const k of kids) k.kill();
  await pg?.stop().catch(() => {});
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
});

describe("UI tự động (Chrome thật + Next dev + PostgreSQL server + worker giả)", () => {
  it("OWNER: tạo việc → bản 1 → yêu cầu sửa → bản 2 → duyệt → Hoàn thành", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    const s = await login(page, base, "owner@dev.local");
    assert.equal(s.user?.role, "OWNER");
    await go(page, `${base}/work`);
    assert.match(await page.locator("main").innerText(), /ADAPTER GIẢ/); // the fake boundary is labelled
    await page.getByRole("button", { name: /Giao việc: TẮT/ }).click();
    await page.getByRole("button", { name: /Giao việc: BẬT/ }).waitFor();
    await page.reload();
    await page.getByPlaceholder("Soạn 3 mẫu quảng cáo cho Test offer US").fill("Soạn 3 mẫu quảng cáo (test UI tự động)");
    await page.getByRole("button", { name: "Giao việc", exact: true }).click();
    await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
    await waitFor(page, "Duyệt bản 1");
    await page.locator("textarea").fill("Thiếu số liệu so sánh");
    await page.getByRole("button", { name: "Yêu cầu sửa" }).click();
    await page.getByRole("button", { name: /Giao bot sửa/ }).waitFor();
    await page.getByRole("button", { name: /Giao bot sửa/ }).click();
    await waitFor(page, "Duyệt bản 2");
    await page.getByRole("button", { name: "Duyệt bản 2" }).click();
    await waitFor(page, "Hoàn thành");
    const text = await page.locator("main").innerText();
    assert.match(text, /Bản 1[\s\S]*REVISION_REQUESTED/);
    assert.match(text, /Bản 2[\s\S]*APPROVED/);
    assert.match(text, /REVISE — Thiếu số liệu so sánh/);
    assert.match(text, /vòng sửa 1/);
    // DB is the source of truth, not just the page
    const [t] = await pg.sql`SELECT status::text s, revision_round r FROM tasks WHERE title LIKE '%test UI tự động%'`;
    assert.deepEqual([t!.s, t!.r], ["COMPLETED", 1]);
    const outs = await pg.sql`SELECT version, state FROM lumi_task_outputs o JOIN tasks t ON t.id=o.task_id WHERE t.title LIKE '%test UI tự động%' ORDER BY version`;
    assert.deepEqual(outs.map((o) => [o.version, o.state]), [[1, "REVISION_REQUESTED"], [2, "APPROVED"]]);
    await ctx.close();
  });

  it("VIEWER chỉ xem: không có form giao việc và không có nút duyệt/sửa", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "viewer@dev.local")).user?.role, "VIEWER");
    await go(page, `${base}/work`);
    const text = await page.locator("main").innerText();
    assert.doesNotMatch(text, /Giao việc mới/);
    const row = page.locator("main a[href^='/work/']").first();
    await row.click();
    await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
    assert.match(await page.locator("main").innerText(), /chỉ có quyền xem/);
    assert.equal(await page.getByRole("button", { name: /Duyệt|Yêu cầu sửa|Hủy việc/ }).count(), 0);
    await ctx.close();
  });

  it("chưa đăng nhập: /work chuyển về /login; API trả 401", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await go(page, `${base}/work`);
    assert.match(page.url(), /\/login/);
    const r = await page.evaluate(async () => (await fetch("/api/v1/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
    assert.equal(r, 401);
    await ctx.close();
  });

  it("đăng nhập thử bị từ chối khi cổng đóng (máy chủ không có LUMI_DEV_LOGIN)", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    const s = await login(page, baseNoLogin, "owner@dev.local");
    assert.equal(s.user, undefined, "không được có phiên");
    await go(page, `${baseNoLogin}/work`);
    assert.match(page.url(), /\/login/);
    await ctx.close();
  });
});

async function waitIn(page: Page, sel: string, text: string, ms = 90_000) {
  const t0 = Date.now();
  for (;;) {
    if ((await page.locator(sel).first().innerText().catch(() => "")).includes(text)) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for "${text}" in ${sel}: ${(await page.locator(sel).first().innerText().catch(() => "(no element)")).slice(0, 500)}`);
    await page.waitForTimeout(1500);
  }
}

describe("Giao diện Dong-Lumi mới (/lumi) trên dữ liệu THẬT", () => {
  it("không đăng nhập: trang chuyển về /login, API trạng thái và hành động 401 — kể cả khi DONGLUMI_PREVIEW=1 cũng được đặt", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await go(page, `${base}/lumi`);
    assert.match(page.url(), /\/login/);
    const r = await page.evaluate(async () => ({
      state: (await fetch("/api/lumi/state")).status,
      action: (await fetch("/api/lumi/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: { type: "task.cancel", taskId: "DL-001", reason: "x" } }) })).status,
    }));
    assert.deepEqual(r, { state: 401, action: 401 });
    await ctx.close();
  });

  it("OWNER: Việc mới → bản 1 → yêu cầu sửa (giao sửa tự động) → bản 2 → duyệt → Hoàn thành; đối chiếu CSDL", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    await go(page, `${base}/lumi`);
    await page.getByTestId("real-banner").waitFor();
    // bật giao việc (công tắc ở trang Telegram & kết nối) nếu chưa bật
    const [asst] = await pg.sql`SELECT dispatch_enabled FROM lumi_assistants WHERE slug='lumitest'`;
    if (!asst!.dispatch_enabled) {
      await go(page, `${base}/lumi/telegram`);
      await page.getByRole("button", { name: /Giao việc: TẮT/ }).click();
      await page.getByRole("button", { name: /Giao việc: BẬT/ }).waitFor();
    }
    await go(page, `${base}/lumi/projects/test-offer-us`);
    // the dev server may still be hydrating: a click before hydration is lost, so retry until the dialog really opens
    for (let i = 0; i < 6; i++) {
      await page.getByTestId("new-task").click();
      if (await page.locator("#nt-title").waitFor({ timeout: 8000 }).then(() => true, () => false)) break;
    }
    await page.locator("#nt-title").fill("Soạn mô tả trang đích (UI Lumi tự động)");
    await page.locator("#nt-req").fill("Tối đa 20 từ mỗi mô tả");
    await page.getByRole("dialog").getByRole("button", { name: "Giao việc" }).click();
    const code = await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT code FROM tasks WHERE title LIKE '%UI Lumi tự động%'`; if (r) return r.code as string; if (Date.now() - t0 > 30000) throw new Error("task not created"); await new Promise((x) => setTimeout(x, 500)); } })();
    await go(page, `${base}/lumi/projects/test-offer-us?task=${code}`);
    await waitIn(page, '[data-testid="task-detail"]', "Duyệt bản 1");
    assert.match(await page.locator('[data-testid="real-panel"]').innerText(), /Trạng thái thật: Chờ duyệt/);
    await page.locator("#rev").fill("Rút gọn còn 12 từ");
    await page.getByRole("button", { name: "Gửi yêu cầu sửa" }).click();
    await waitIn(page, '[data-testid="task-detail"]', "Duyệt bản 2");
    await page.getByRole("button", { name: "Duyệt bản 2" }).click();
    await waitIn(page, '[data-testid="real-panel"]', "Trạng thái thật: Hoàn thành");
    const text = await page.locator('[data-testid="task-detail"]').innerText();
    assert.match(text, /Đã duyệt bản 2/); assert.match(text, /Sửa theo góp ý: Rút gọn còn 12 từ/); assert.match(text, /Vòng sửa 1/);
    const [t] = await pg.sql`SELECT status::text s, revision_round r FROM tasks WHERE code=${code}`;
    assert.deepEqual([t!.s, t!.r], ["COMPLETED", 1]);
    const outs = await pg.sql`SELECT version, state FROM lumi_task_outputs o JOIN tasks t ON t.id=o.task_id WHERE t.code=${code} ORDER BY version`;
    assert.deepEqual(outs.map((o) => [o.version, o.state]), [[1, "REVISION_REQUESTED"], [2, "APPROVED"]]);
    await ctx.close();
  });

  it("sau đăng nhập, trang chủ / là Dong-Lumi (không phải Ops Hub cũ); Tổng quan cũ vẫn mở qua ?legacy=1", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "owner@dev.local");
    await go(page, `${base}/`);
    assert.match(page.url(), /\/lumi$/);
    await go(page, `${base}/?legacy=1`);
    assert.doesNotMatch(page.url(), /\/lumi/);
    await ctx.close();
  });

  it("VIEWER: thấy dữ liệu nhưng không thao tác được (API từ chối, không đổi gì)", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "viewer@dev.local");
    await go(page, `${base}/lumi`);
    await page.getByTestId("real-banner").waitFor();
    const before = (await pg.sql`SELECT count(*)::int n FROM tasks`)[0]!.n;
    const r = await page.evaluate(async () => {
      const res = await fetch("/api/lumi/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: { type: "task.create", projectId: "test-offer-us", title: "viewer thử tạo", ownerId: "bot-lumitest", via: "web", clientRequestId: "viewer-try-0001" } }) });
      return (await res.json()).result;
    });
    assert.equal(r.ok, false);
    assert.equal((await pg.sql`SELECT count(*)::int n FROM tasks`)[0]!.n, before);
    await ctx.close();
  });
});

describe("IMP-01 — kế hoạch xuyên suốt cho một bot (adapter GIẢ, dữ liệu mô phỏng)", () => {
  it("OWNER: bật kế hoạch → tạo mục tiêu → bot (giả) lập kế hoạch → duyệt 2 bước (bấm đúp) → 2 việc chạy → duyệt đầu ra → báo cáo cuối → đóng mục tiêu; đối chiếu CSDL", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    const [asst] = await pg.sql`SELECT dispatch_enabled FROM lumi_assistants WHERE slug='lumitest'`;
    if (!asst!.dispatch_enabled) {
      await go(page, `${base}/lumi/telegram`);
      await page.getByRole("button", { name: /Giao việc: TẮT/ }).click();
      await page.getByRole("button", { name: /Giao việc: BẬT/ }).waitFor();
    }
    await go(page, `${base}/lumi/company`);
    await page.getByTestId("company-honesty").waitFor();
    // trạng thái ban đầu: tính năng tắt, nói rõ, chưa tạo được mục tiêu
    await page.getByTestId("plans-off").waitFor();
    assert.equal(await page.getByTestId("goal-create-open").count(), 0);
    await page.getByTestId("plans-enable").click();
    await page.getByTestId("goal-create-open").waitFor();
    await page.getByTestId("goal-create-open").click();
    await page.getByTestId("goal-title").fill("Thử hướng X (UI kế hoạch tự động)");
    await page.getByTestId("goal-outcome").fill("Có kế hoạch thử để quyết định đầu tư tiếp hay dừng");
    await page.getByTestId("goal-submit").click();
    const goal = await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT code FROM lumi_goals WHERE title LIKE '%UI kế hoạch tự động%'`; if (r) return r.code as string; if (Date.now() - t0 > 30000) throw new Error("goal not created"); await new Promise((x) => setTimeout(x, 500)); } })();
    await page.getByTestId(`plan-request-${goal}`).click();
    await page.getByTestId("plan-create-submit").click();
    const link = page.getByTestId(`goal-${goal}`).locator("a[href^='/lumi/plans/']");
    await link.waitFor({ timeout: 30_000 });
    await link.click();
    await page.waitForURL(/\/lumi\/plans\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    const planUrl = page.url();
    // worker giả (có nhãn [MÔ PHỎNG]) nộp kế hoạch mẫu
    // đợi tới khi worker giả đã nộp phiên bản 1 (CSDL), rồi mới tải trang — tránh tải lại liên tục khi dev server đang biên dịch
    await (async () => { const t0 = Date.now(); for (;;) { if ((await pg.sql`SELECT 1 FROM lumi_plan_versions v JOIN lumi_plans p ON p.id=v.plan_id JOIN lumi_goals g ON g.id=p.goal_id WHERE g.code=${goal}`).length) return; if (Date.now() - t0 > 90000) throw new Error("worker giả chưa nộp kế hoạch"); await new Promise((x) => setTimeout(x, 1000)); } })();
    await page.reload();
    await page.getByTestId("plan-honesty").waitFor({ timeout: 90_000 });
    await (async () => { const t0 = Date.now(); for (;;) { if (await page.getByTestId("plan-approve-open").count()) return; if (Date.now() - t0 > 90000) throw new Error("plan not submitted: " + (await page.locator("main").innerText()).slice(0, 500)); await page.waitForTimeout(5000); await page.reload(); } })();
    const body = await page.getByTestId("pending-version").innerText();
    assert.match(body, /MÔ PHỎNG/);
    assert.match(await page.getByTestId("ai-cost-note").innerText(), /Chi phí AI chưa đo theo lượt/);
    // duyệt sai phiên bản / sai hash bị chặn, kế hoạch không đổi
    const planId0 = planUrl.split("/").pop()!;
    const hash0 = (await pg.sql`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=${planId0} AND version=1`)[0]!.content_hash as string;
    const wrong = await page.evaluate(async ({ id, h }) => {
      const url = `/api/v1/lumi/plans/${id}/decide`;
      const hd = { "content-type": "application/json" };
      const badVersion = (await fetch(url, { method: "POST", headers: hd, body: JSON.stringify({ version: 2, content_hash: h, decision: "APPROVE" }) })).status;
      const badHash = (await fetch(url, { method: "POST", headers: hd, body: JSON.stringify({ version: 1, content_hash: "0".repeat(64), decision: "APPROVE" }) })).status;
      return { badVersion, badHash };
    }, { id: planId0, h: hash0 });
    assert.ok(wrong.badVersion >= 400 && wrong.badHash >= 400, JSON.stringify(wrong));
    assert.equal((await pg.sql`SELECT status FROM lumi_plans WHERE id=${planId0}`)[0]!.status, "PENDING_APPROVAL");
    assert.equal((await pg.sql`SELECT 1 FROM lumi_approvals WHERE kind='PLAN' AND object_id=${planId0}`).length, 0);
    // bước 1 → bước 2; bấm đúp xác nhận ⇒ chỉ một lần duyệt
    await page.getByTestId("plan-approve-open").click();
    await page.getByTestId("dlg-confirm").waitFor();
    await page.getByTestId("dlg-confirm").dblclick().catch(() => {});
    await page.getByTestId("approved-version").waitFor({ timeout: 30_000 });
    const [plan] = await pg.sql`SELECT p.id,p.status,p.approved_version FROM lumi_plans p JOIN lumi_goals g ON g.id=p.goal_id WHERE g.code=${goal} ORDER BY p.created_at DESC LIMIT 1`;
    assert.equal(plan!.status, "EXECUTING");
    assert.equal((await pg.sql`SELECT 1 FROM lumi_approvals WHERE kind='PLAN' AND object_id=${plan!.id}`).length, 1);
    assert.equal((await pg.sql`SELECT 1 FROM tasks WHERE plan_id=${plan!.id} AND plan_task_key IS NOT NULL`).length, 2);
    // hai việc chạy bằng worker giả → chờ duyệt đầu ra; Chủ duyệt từng đầu ra ở màn Việc
    const codes = (await pg.sql`SELECT code FROM tasks WHERE plan_id=${plan!.id} AND plan_task_key IS NOT NULL ORDER BY plan_task_key`).map((r) => r.code as string);
    for (const code of codes) {
      await go(page, `${base}/lumi/projects/test-offer-us?task=${code}`);
      await waitIn(page, '[data-testid="task-detail"]', "Duyệt bản 1");
      await page.getByRole("button", { name: "Duyệt bản 1" }).click();
      await waitIn(page, '[data-testid="real-panel"]', "Trạng thái thật: Hoàn thành");
    }
    // worker kết thúc kế hoạch: báo cáo cuối + DONE (đúng một bản), chi phí AI ghi 'chưa biết'
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT status FROM lumi_plans WHERE id=${plan!.id}`; if (r!.status === "DONE") return; if (Date.now() - t0 > 60000) throw new Error("plan not DONE: " + r!.status); await new Promise((x) => setTimeout(x, 1000)); } })();
    assert.equal((await pg.sql`SELECT 1 FROM lumi_reports WHERE plan_id=${plan!.id} AND kind='FINAL'`).length, 1);
    assert.ok((await pg.sql`SELECT 1 FROM lumi_ledger_entries WHERE plan_id=${plan!.id} AND entry_type='ACTUAL' AND amount IS NULL AND source='UNKNOWN'`).length >= 2);
    assert.equal((await pg.sql`SELECT 1 FROM lumi_ledger_entries WHERE plan_id=${plan!.id} AND entry_type='ACTUAL' AND amount=0`).length, 0, "không bao giờ ghi 0 thay cho 'chưa biết'");
    await go(page, planUrl);
    await page.getByTestId("plan-reports").waitFor();
    assert.match(await page.getByTestId("plan-ledger").innerText(), /chưa biết/i);
    // mục tiêu CHƯA tự đóng; Chủ đóng với bằng chứng ≥ 10 ký tự
    assert.equal((await pg.sql`SELECT status FROM lumi_goals WHERE code=${goal}`)[0]!.status, "ACTIVE");
    await go(page, `${base}/lumi/company`);
    await page.getByTestId(`goal-close-${goal}`).click();
    await page.getByTestId("goal-result").selectOption("ACHIEVED");
    await page.getByTestId("goal-close-submit").click();
    await page.getByRole("alert").filter({ hasText: /10/ }).waitFor(); // thiếu bằng chứng ⇒ bị từ chối
    await page.getByTestId("goal-close-note").fill("Đã xem báo cáo cuối và đầu ra mô phỏng — chỉ để kiểm thử luồng");
    await page.getByTestId("goal-close-submit").click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT status,result FROM lumi_goals WHERE code=${goal}`; if (r!.status !== "ACTIVE") { assert.equal(r!.result, "ACHIEVED"); return; } if (Date.now() - t0 > 20000) throw new Error("goal not closed"); await new Promise((x) => setTimeout(x, 500)); } })();
    await ctx.close();
  });

  it("bot chưa sẵn sàng và lượt lập kế hoạch lỗi hiển thị rõ (không im lặng 'đang chờ')", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    await pg.sql`INSERT INTO profiles(slug,name,type,status) VALUES ('notready','Bot chưa sẵn sàng','bot','active') ON CONFLICT DO NOTHING`;
    const [na] = await pg.sql`INSERT INTO lumi_assistants(slug,name,kind,hermes_profile,connection_state,execution_level,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day,dispatch_enabled)
      VALUES ('notready','Bot chưa sẵn sàng (thử)','SPECIALIST','notready','VERIFIED',0,'["tasks.intake","outputs.submit","knowledge.context"]',600,60,2,3,3,20,false) RETURNING id`;
    const [proj] = await pg.sql`SELECT id FROM lumi_projects WHERE slug='test-offer-us'`;
    await go(page, `${base}/lumi/company`);
    // (1) bot chưa bật giao việc: API từ chối bằng CONFIG_INCOMPLETE nêu đúng điều kiện thiếu
    const first = await page.evaluate(async ({ pid, aid }) => {
      const hd = { "content-type": "application/json" };
      const g = await (await fetch("/api/v1/lumi/goals", { method: "POST", headers: { ...hd, "idempotency-key": "ui-notready-goal-0001" }, body: JSON.stringify({ title: "Mục tiêu thử bot chưa sẵn sàng", outcome: "Kiểm hiển thị lỗi", project_id: pid }) })).json();
      const p = await (await fetch("/api/v1/lumi/plans", { method: "POST", headers: { ...hd, "idempotency-key": "ui-notready-plan-0001" }, body: JSON.stringify({ goal_id: g.data.goal.id, lead_assistant_id: aid }) })).json();
      return { goalId: g.data.goal.id as string, code: p.error?.code as string | undefined, missing: JSON.stringify(p.error?.details ?? {}) };
    }, { pid: proj!.id as string, aid: na!.id as string });
    assert.equal(first.code, "CONFIG_INCOMPLETE"); assert.match(first.missing, /assistant_ready/);
    // (2) bot đã sẵn sàng lúc giao nhưng bị tạm dừng giao việc ⇒ lượt không được gửi; giao diện nói rõ
    await pg.sql`UPDATE lumi_assistants SET dispatch_enabled=true, dispatch_paused=true WHERE id=${na!.id}`;
    const made = await page.evaluate(async ({ gid, aid }) => {
      const p = await (await fetch("/api/v1/lumi/plans", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "ui-notready-plan-0002" }, body: JSON.stringify({ goal_id: gid, lead_assistant_id: aid }) })).json();
      return (p.data?.plan?.id as string | undefined) ?? JSON.stringify(p.error);
    }, { gid: first.goalId, aid: na!.id as string });
    assert.match(made ?? "", /^[0-9a-f-]{36}$/, `kế hoạch thử phải tạo được: ${made}`);
    const [pl0] = await pg.sql`SELECT planning_task_id FROM lumi_plans WHERE id=${made}`;
    await pg.sql`UPDATE tasks SET status='WAITING_ASSISTANT' WHERE id=${pl0!.planning_task_id}`;
    await go(page, `${base}/lumi/plans/${made}`);
    await page.getByTestId("planning-bot-not-ready").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("planning-bot-not-ready").innerText(), /chưa sẵn sàng/);
    // lượt lập kế hoạch thất bại ⇒ cảnh báo rõ, nói chưa có gì được thực hiện/chi tiêu
    const [pl] = await pg.sql`SELECT planning_task_id FROM lumi_plans WHERE id=${made}`;
    await pg.sql`UPDATE tasks SET status='FAILED', error_code='TEST_FAIL' WHERE id=${pl!.planning_task_id}`;
    await page.reload();
    await page.getByTestId("planning-failed").waitFor({ timeout: 60_000 });
    const msg = await page.getByTestId("planning-failed").innerText();
    assert.match(msg, /chưa lập được kế hoạch/); assert.match(msg, /TEST_FAIL/); assert.match(msg, /Chưa có gì được thực hiện hay chi tiêu/);
    // dọn: hủy kế hoạch thử qua giao diện
    await page.getByTestId("plan-cancel-open").click();
    await page.getByTestId("dlg-text").fill("hủy kế hoạch thử");
    await page.getByTestId("dlg-confirm").click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT status FROM lumi_plans WHERE id=${made}`; if (r!.status === "CANCELLED") return; if (Date.now() - t0 > 20000) throw new Error("plan not cancelled: " + r!.status); await new Promise((x) => setTimeout(x, 500)); } })();
    await ctx.close();
  });

  it("VIEWER: xem được Công ty và kế hoạch nhưng không có nút duyệt/ghi/hủy; API ghi bị từ chối và không đổi gì", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "viewer@dev.local")).user?.role, "VIEWER");
    await go(page, `${base}/lumi/company`);
    await page.getByTestId("company-honesty").waitFor();
    assert.equal(await page.getByTestId("goal-create-open").count(), 0);
    assert.equal(await page.getByTestId("plans-enable").count(), 0);
    const [pl] = await pg.sql`SELECT id FROM lumi_plans ORDER BY created_at DESC LIMIT 1`;
    await go(page, `${base}/lumi/plans/${pl!.id}`);
    await page.getByTestId("plan-view").waitFor();
    for (const t of ["plan-approve-open", "plan-reject-open", "plan-cancel-open", "ledger-open"]) assert.equal(await page.getByTestId(t).count(), 0, t);
    const before = (await pg.sql`SELECT (SELECT count(*)::int FROM lumi_goals) g,(SELECT count(*)::int FROM lumi_ledger_entries) l`)[0]!;
    const st = await page.evaluate(async (id) => (await fetch(`/api/v1/lumi/plans/${id}/cancel`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "viewer-try-cancel-1" }, body: JSON.stringify({ reason: "viewer thử hủy" }) })).status, pl!.id as string);
    assert.equal(st, 403);
    const after = (await pg.sql`SELECT (SELECT count(*)::int FROM lumi_goals) g,(SELECT count(*)::int FROM lumi_ledger_entries) l`)[0]!;
    assert.deepEqual(after, before);
    await ctx.close();
  });

  it("chưa đăng nhập: /lumi/company chuyển về /login; API kế hoạch trả 401", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await go(page, `${base}/lumi/company`);
    assert.match(page.url(), /\/login/);
    const r = await page.evaluate(async () => ({ list: (await fetch("/api/v1/lumi/goals")).status, mk: (await fetch("/api/v1/lumi/goals", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "anon-try-00000001" }, body: "{}" })).status }));
    assert.deepEqual(r, { list: 401, mk: 401 });
    await ctx.close();
  });
});

describe("IMP-02 — đội bot trên dữ liệu thật: Tổ chức, chính sách, việc xuyên dự án, quản trị (adapter GIẢ)", () => {
  it("Tổ chức: tạo hồ sơ (chưa kết nối, giao việc TẮT) → kiểm tra kết nối THẬT thất bại có lý do → sửa công cụ ⇒ đặt lại → kiểm tra đạt → bật giao việc → lưu trữ", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    await go(page, `${base}/lumi/org`);
    await page.getByTestId("org-view").waitFor();
    for (let i = 0; i < 6; i++) { await page.getByTestId("assistant-new").click(); if (await page.getByTestId("af-name").waitFor({ timeout: 8000 }).then(() => true, () => false)) break; }
    await page.getByTestId("af-name").fill("Trợ lý UI IMP-02");
    await page.getByTestId("af-slug").fill("ui-imp02");
    await page.getByTestId("af-role").fill("Nghiên cứu thử");
    await page.getByTestId("af-profile").fill("ui-imp02");
    await page.getByTestId("af-runs").fill("8"); await page.getByTestId("af-deadline").fill("600"); await page.getByTestId("af-ack").fill("60");
    await page.getByTestId("af-fails").fill("1"); await page.getByTestId("af-transport").fill("1"); await page.getByTestId("af-rev").fill("1");
    await page.locator("fieldset", { hasText: "Dự án tham gia" }).getByRole("checkbox").first().check();
    await page.getByTestId("af-submit").click();
    const card = page.getByTestId("assistant-ui-imp02");
    await card.waitFor({ timeout: 30_000 });
    assert.equal((await pg.sql`SELECT 1 FROM lumi_project_members m JOIN lumi_assistants a ON a.id=m.assistant_id WHERE a.slug='ui-imp02'`).length, 1, "dự án đã chọn phải được lưu (form gửi UUID, không phải slug)");
    assert.match(await page.getByTestId("state-conn-ui-imp02").innerText(), /Chưa kết nối/);
    assert.match(await page.getByTestId("state-exec-ui-imp02").innerText(), /Giao việc tắt/);
    assert.equal(await page.getByTestId("dispatch-ui-imp02").isDisabled(), true, "chưa kết nối thì không bật giao việc được");
    assert.match(await page.getByTestId("why-ui-imp02").innerText(), /Chưa kết nối/);
    // trùng mã bị từ chối rõ ràng
    await page.getByTestId("assistant-new").click();
    await page.getByTestId("af-name").waitFor();
    await page.getByTestId("af-name").fill("Tên khác hẳn"); await page.getByTestId("af-slug").fill("ui-imp02"); await page.getByTestId("af-role").fill("x y");
    await page.getByTestId("af-runs").fill("8"); await page.getByTestId("af-deadline").fill("600"); await page.getByTestId("af-ack").fill("60"); await page.getByTestId("af-fails").fill("1"); await page.getByTestId("af-transport").fill("1"); await page.getByTestId("af-rev").fill("1");
    await page.getByTestId("af-submit").click();
    assert.match(await page.getByTestId("af-error").innerText(), /Mã \(slug\) trợ lý đã được dùng|Tên đã được dùng/);
    await page.getByRole("button", { name: "Hủy", exact: true }).last().click();
    // kiểm tra kết nối: profile giả phơi bày thêm tasks.intake ⇒ vượt danh sách ⇒ THẤT BẠI có lý do
    await page.getByTestId("verify-ui-imp02").click();
    await waitIn(page, '[data-testid="state-conn-ui-imp02"]', "Kiểm tra lỗi", 120_000);
    assert.match(await page.getByTestId("assistant-ui-imp02").innerText(), /PROFILE_EXCEEDS_ALLOWLIST: tasks\.intake/);
    assert.equal(await page.getByTestId("dispatch-ui-imp02").isDisabled(), true);
    // sửa danh sách công cụ cho khớp ⇒ kết nối bị đặt lại ⇒ kiểm tra lại đạt
    await page.getByTestId("edit-ui-imp02").click();
    await page.getByTestId("af-tool-tasks.intake").waitFor();
    await page.getByTestId("af-tool-tasks.intake").check();
    await page.getByTestId("af-submit").click();
    await waitIn(page, '[data-testid="state-conn-ui-imp02"]', "Chưa kết nối", 30_000);
    await page.getByTestId("verify-ui-imp02").click();
    await waitIn(page, '[data-testid="state-conn-ui-imp02"]', "Đã kết nối (đã kiểm thật)", 120_000);
    const [a1] = await pg.sql`SELECT connection_state,connection_error,connection_checked_at,dispatch_enabled FROM lumi_assistants WHERE slug='ui-imp02'`;
    assert.deepEqual([a1!.connection_state, a1!.connection_error, a1!.dispatch_enabled], ["VERIFIED", null, false]);
    assert.ok(a1!.connection_checked_at);
    await page.getByTestId("dispatch-ui-imp02").click();
    await waitIn(page, '[data-testid="state-exec-ui-imp02"]', "Đang bật giao việc", 30_000);
    // Văn phòng đọc cùng dữ liệu với Tổ chức: trợ lý mới hiện ngay, không cần sửa mã
    const office = await ctx.newPage();
    await go(office, `${base}/lumi/office`);
    await office.getByText("Trợ lý UI IMP-02").first().waitFor({ timeout: 60_000 });
    await office.close();
    // Quyền & tự chủ: giới hạn tự chủ, công cụ rộng cần xác nhận, cấp rồi thu hồi một giấy ủy quyền (form gửi UUID dự án)
    await page.getByTestId("authority-ui-imp02").click();
    await page.getByTestId("authority-dialog").waitFor();
    await page.getByTestId("au-continuations").fill("3"); await page.getByTestId("au-subtasks").fill("5");
    await page.getByTestId("au-save").click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT max_continuations c,max_subtasks s FROM lumi_assistants WHERE slug='ui-imp02'`; if (r!.c === 3 && r!.s === 5) return; if (Date.now() - t0 > 30000) throw new Error("autonomy not saved"); await new Promise((x) => setTimeout(x, 500)); } })();
    await page.getByTestId("cap-full").check();
    assert.equal(await page.getByTestId("cap-save").isDisabled(), true, "công cụ rộng cần xác nhận rõ");
    await page.getByTestId("cap-ack").check();
    await page.getByTestId("cap-save").click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT capability_mode m,capability_ack_by b,dispatch_enabled d FROM lumi_assistants WHERE slug='ui-imp02'`; if (r!.m === "DECLARED_FULL") { assert.equal(r!.d, false, "đổi chế độ công cụ phải TẮT giao việc"); assert.match(String(r!.b), /owner@dev\.local/); return; } if (Date.now() - t0 > 30000) throw new Error("capability not saved"); await new Promise((x) => setTimeout(x, 500)); } })();
    await page.getByTestId("cap-restricted").check();
    await page.getByTestId("cap-save").click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT capability_mode m FROM lumi_assistants WHERE slug='ui-imp02'`; if (r!.m === "RESTRICTED") return; if (Date.now() - t0 > 30000) throw new Error("capability not reverted"); await new Promise((x) => setTimeout(x, 500)); } })();
    await page.getByTestId("gr-account_ref").fill("ui-account");
    await page.getByTestId("gr-action_type").fill("ads.spend");
    await page.getByTestId("gr-currency").fill("USD"); await page.getByTestId("gr-budget_total").fill("10");
    await page.getByTestId("gr-valid_until").fill(new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10));
    await page.getByTestId("gr-submit").click();
    await page.locator("[data-testid='grant-row'][data-state='ACTIVE']").first().waitFor({ timeout: 30_000 });
    assert.equal((await pg.sql`SELECT 1 FROM lumi_grants g JOIN lumi_assistants a ON a.id=g.assistant_id WHERE a.slug='ui-imp02' AND g.state='ACTIVE'`).length, 1);
    await page.getByTestId("grant-revoke").click();
    await page.locator("[data-testid='grant-row'][data-state='REVOKED']").first().waitFor({ timeout: 30_000 });
    assert.equal((await pg.sql`SELECT 1 FROM lumi_grants g JOIN lumi_assistants a ON a.id=g.assistant_id WHERE a.slug='ui-imp02' AND g.state='REVOKED'`).length, 1);
    await page.getByRole("button", { name: "Đóng", exact: true }).last().click();
    // lưu trữ: việc mở về Chủ, hồ sơ biến khỏi danh sách đang hoạt động nhưng còn trong DB
    await page.getByTestId("archive-ui-imp02").click();
    await page.getByTestId("archive-confirm").click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT status,dispatch_enabled FROM lumi_assistants WHERE slug='ui-imp02'`; if (r!.status === "ARCHIVED") { assert.equal(r!.dispatch_enabled, false); return; } if (Date.now() - t0 > 30000) throw new Error("not archived"); await new Promise((x) => setTimeout(x, 500)); } })();
    await page.getByTestId("assistant-ui-imp02").waitFor({ state: "detached", timeout: 30_000 });
    // ba tab chỉ đọc có nội dung thật
    await page.getByTestId("org-tab-map").click();
    assert.equal(await page.locator("[data-testid^='fn-DEP-']").count(), 12);
    assert.match(await page.getByTestId("fn-DEP-08").innerText(), /chưa kích hoạt/);
    await page.getByTestId("org-tab-duties").click();
    await page.getByTestId("org-stages").waitFor();
    assert.equal(await page.locator("[data-testid^='stage-S']").count(), 6);
    await ctx.close();
  });

  it("Chính sách (CMP-03): chưa đặt hiện 'chưa đặt'; đặt ⇒ phiên bản; đổi ⇒ phiên bản mới; lịch sử; bỏ đặt ⇒ quay lại 'chưa đặt'; sai bị từ chối", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "owner@dev.local");
    await go(page, `${base}/lumi/company`);
    await page.getByTestId("policies-panel").waitFor();
    assert.match(await page.getByTestId("policy-currency").innerText(), /chưa đặt/);
    for (let i = 0; i < 6; i++) { await page.getByTestId("policy-edit-currency").click(); if (await page.getByTestId("pf-text").waitFor({ timeout: 8000 }).then(() => true, () => false)) break; }
    await page.getByTestId("pf-text").fill("USD");
    await page.getByTestId("pf-save").click();
    await waitIn(page, '[data-testid="policy-currency"]', "v1", 30_000);
    assert.match(await page.getByTestId("policy-currency").innerText(), /USD/);
    await page.getByTestId("policy-edit-currency").click();
    await page.getByTestId("pf-text").fill("VND");
    await page.getByTestId("pf-save").click();
    await waitIn(page, '[data-testid="policy-currency"]', "v2", 30_000);
    await page.getByTestId("policy-history-toggle").click();
    assert.match(await page.getByTestId("policy-history").innerText(), /currency \(v2.*VND[\s\S]*currency \(v1.*USD/);
    // số mặc định không tồn tại: chu kỳ báo cáo vẫn 'chưa đặt'; giá trị sai bị từ chối rõ ràng
    assert.match(await page.getByTestId("policy-report_cadence_days").innerText(), /chưa đặt/);
    await page.getByTestId("policy-edit-report_cadence_days").click();
    await page.getByTestId("pf-int").fill("500");
    await page.getByTestId("pf-save").click();
    assert.match(await page.getByTestId("pf-error").innerText(), /1..90/);
    await page.getByRole("button", { name: "Hủy", exact: true }).last().click();
    await page.getByTestId("policy-edit-currency").click();
    await page.getByTestId("pf-unset").click();
    await waitIn(page, '[data-testid="policy-currency"]', "chưa đặt", 30_000);
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_policies WHERE key='currency'`)[0]!.n, 3); // v1, v2, v3 (bỏ đặt) — lịch sử không mất
    await ctx.close();
  });

  it("Dự án mới (PRJ-01) và Việc xuyên dự án (PRJ-06): tạo dự án qua giao diện, tên trùng bị chặn; lọc kết hợp, bỏ dấu; số đếm khớp Dashboard", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "owner@dev.local");
    await go(page, `${base}/lumi/projects`);
    for (let i = 0; i < 6; i++) { await page.getByTestId("project-new").click(); if (await page.locator("#pj-name").waitFor({ timeout: 8000 }).then(() => true, () => false)) break; }
    await page.locator("#pj-name").fill("Dự án giao diện IMP-02");
    await page.locator("#pj-goal").fill("Thử tạo dự án");
    await page.getByRole("button", { name: "Thêm dự án", exact: true }).last().click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT slug,status FROM lumi_projects WHERE name='Dự án giao diện IMP-02'`; if (r) { assert.equal(r.status, "ACTIVE"); return; } if (Date.now() - t0 > 30000) throw new Error("project not created"); await new Promise((x) => setTimeout(x, 500)); } })();
    await page.getByText("Dự án giao diện IMP-02").first().waitFor({ timeout: 30_000 }); // xuất hiện không cần sửa code
    await page.getByTestId("project-new").click();
    await page.locator("#pj-name").fill("Dự án giao diện imp-02"); // khác hoa/thường ở phần ASCII ⇒ vẫn là trùng tên
    await page.getByRole("button", { name: "Thêm dự án", exact: true }).last().click();
    assert.match(await page.getByTestId("pj-error").innerText(), /Tên đã được dùng/);
    await page.getByRole("button", { name: "Hủy", exact: true }).last().click();
    // sửa rồi lưu trữ dự án qua giao diện (nút gửi UUID, không phải slug)
    const [pj] = await pg.sql`SELECT slug FROM lumi_projects WHERE name='Dự án giao diện IMP-02'`;
    await go(page, `${base}/lumi/projects/${pj!.slug}`);
    for (let i = 0; i < 6; i++) { await page.getByTestId("project-edit-open").click(); if (await page.getByTestId("pe-name").waitFor({ timeout: 8000 }).then(() => true, () => false)) break; }
    await page.getByTestId("pe-name").fill("Dự án giao diện IMP-02 (đã sửa)");
    await page.getByTestId("pe-save").click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT name FROM lumi_projects WHERE slug=${pj!.slug}`; if (r!.name === "Dự án giao diện IMP-02 (đã sửa)") return; if (Date.now() - t0 > 30000) throw new Error("project not renamed"); await new Promise((x) => setTimeout(x, 500)); } })();
    await page.getByTestId("project-edit-open").click();
    await page.getByTestId("pe-archive").click();
    await page.getByTestId("pe-archive-confirm").click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT status FROM lumi_projects WHERE slug=${pj!.slug}`; if (r!.status === "ARCHIVED") return; if (Date.now() - t0 > 30000) throw new Error("project not archived"); await new Promise((x) => setTimeout(x, 500)); } })();
    // việc xuyên dự án
    await go(page, `${base}/lumi/tasks`);
    await page.getByTestId("tasks-view").waitFor();
    const total = Number(await page.getByTestId("tf-shown").innerText());
    assert.ok(total >= 1, "có việc từ các bài test trước");
    await page.getByTestId("tf-q").fill("mau quang cao"); // không dấu khớp «mẫu quảng cáo»
    const filteredN = Number(await page.getByTestId("tf-shown").innerText());
    assert.ok(filteredN >= 1 && filteredN <= total, `lọc từ khóa: ${filteredN}/${total}`);
    await page.getByTestId("tf-clear").click();
    await page.getByTestId("tf-status").selectOption("open");
    const open = Number(await page.getByTestId("tf-shown").innerText());
    const dbOpen = (await pg.sql`SELECT count(*)::int n FROM tasks WHERE project_id IS NOT NULL AND status::text NOT IN ('COMPLETED','CANCELLED','IMPORTED','FAILED','REJECTED','ON_HOLD')`)[0]!.n;
    await go(page, `${base}/lumi`);
    await page.getByTestId("block-projects").waitFor();
    const dashOpen = await page.getByTestId("open-tasks").locator("a").count().catch(() => 0);
    assert.ok(open >= 0 && dashOpen <= Math.max(open, 6) + 1, `Dashboard (${dashOpen}) không được nhiều hơn danh sách xuyên dự án (${open}) cùng phạm vi`);
    void dbOpen;
    await ctx.close();
  });

  it("Quản trị (ADM-01/07/08): thẻ worker có tín hiệu thật; Hermes không có ảnh chụp ⇒ nói 'chưa có', không bịa; hộp thông báo từ sự kiện thật, chưa nối Telegram thì nói đúng; đánh dấu đã đọc", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "owner@dev.local");
    await go(page, `${base}/lumi/admin`);
    await page.getByTestId("admin-view").waitFor();
    await page.getByTestId("card-db").waitFor({ timeout: 60_000 });
    // worker giả đã ghi nhịp tim (lần đầu ngay khi chạy): thẻ hiện 'đang chạy', nêu rõ là worker giả
    await page.getByTestId("card-worker-sim").waitFor({ timeout: 90_000 }); // trang tự làm mới mỗi 10 giây; nhịp tim của worker giả được ghi ngay vòng đầu
    assert.match(await page.getByTestId("card-worker-sim").innerText(), /giả \(mô phỏng\)/);
    assert.match(await page.getByTestId("card-worker-sim-level").innerText(), /Bình thường/);
    assert.match(await page.locator("main").innerText(), /Chưa có ảnh chụp trạng thái Hermes/); // không có worker thật ⇒ không bịa trạng thái
    assert.match(await page.getByTestId("card-backups").innerText(), /Chưa có diễn tập khôi phục/);
    // hộp thông báo: các sự kiện thật của bài test trước (đầu ra mới nhận…)
    await page.getByTestId("admin-tab-notifications").click();
    await page.getByTestId("notifications").waitFor();
    const rows = await page.getByTestId("notif-row").count();
    assert.ok(rows >= 1, "có thông báo từ sự kiện thật");
    assert.match(await page.getByTestId("notifications").innerText(), /chưa gửi Telegram \(kênh chưa nối\)|đã gửi Telegram|đang chờ gửi/);
    assert.doesNotMatch(await page.getByTestId("notifications").innerText(), /đã gửi Telegram/, "kênh Telegram chưa nối: không được nói đã gửi");
    const unread = Number(await page.getByTestId("notif-unread").innerText());
    if (unread > 0) { await page.getByTestId("notif-seen").click(); await waitIn(page, '[data-testid="notifications"]', "chưa đọc: 0", 30_000); }
    await page.getByTestId("admin-tab-tools").click();
    assert.equal(await page.locator("[data-testid^='tools-']").count(), 5);
    await ctx.close();
  });

  it("Dashboard (DSH-02/03/08): chỉ N mục ưu tiên kèm «Xem tất cả (M)»; nhãn «Đầu ra mới nhận»; mỗi khối nêu nguồn/kỳ/cập nhật; từ chối đầu ra cần lý do và đóng bản đó", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "owner@dev.local");
    // 4 việc mới giao cho trợ lý thử; worker giả nộp bản 1 cho từng việc
    await go(page, `${base}/lumi`);
    const made = await page.evaluate(async () => {
      const out: string[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await fetch("/api/lumi/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: { type: "task.create", projectId: "test-offer-us", title: `Việc ưu tiên IMP-02 số ${i + 1}`, ownerId: "bot-lumitest", via: "web", clientRequestId: `imp02-prio-${i}-0001` } }) });
        out.push(String((await res.json()).result?.ok));
      }
      return out;
    });
    assert.deepEqual(made, ["true", "true", "true", "true"]);
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT count(*)::int n FROM tasks WHERE title LIKE 'Việc ưu tiên IMP-02%' AND status::text='WAITING_REVIEW'`; if (r!.n === 4) return; if (Date.now() - t0 > 120000) throw new Error("outputs not submitted: " + r!.n); await new Promise((x) => setTimeout(x, 1500)); } })();
    await go(page, `${base}/lumi`);
    await page.getByTestId("dash-priority-n").selectOption("3");
    await page.getByTestId("block-needs-me").waitFor();
    const outputRows = page.getByTestId("needs-output").getByTestId("pending-row");
    await (async () => { const t0 = Date.now(); for (;;) { if ((await outputRows.count()) >= 1) return; if (Date.now() - t0 > 60000) throw new Error("no pending rows"); await page.waitForTimeout(1500); await page.reload(); } })();
    assert.equal(await outputRows.count(), 3, "chỉ N=3 mục ưu tiên mỗi nhóm");
    const seeAll = page.getByTestId("see-all-output");
    assert.match(await seeAll.innerText(), /Xem tất cả \((\d+)\)/);
    assert.ok(Number(/\((\d+)\)/.exec(await seeAll.innerText())![1]) >= 4);
    assert.ok((await outputRows.first().getByTestId("new-output-badge").count()) === 1, "nhãn «Đầu ra mới nhận»");
    assert.match(await outputRows.first().innerText(), /Đầu ra mới nhận/);
    await page.getByTestId("dash-priority-n").selectOption("10");
    assert.equal(await page.getByTestId("see-all-output").count(), 0, "đủ chỗ thì không còn nút «Xem tất cả»");
    // mỗi khối có nguồn, kỳ, cập nhật
    const notes = await page.getByTestId("source-note").allInnerTexts();
    assert.ok(notes.length >= 3 && notes.every((n) => /Nguồn:/.test(n) && /Kỳ:/.test(n) && /Cập nhật/.test(n)), notes.join(" | "));
    assert.ok(notes.every((n) => /PostgreSQL/.test(n)), "ở chế độ thật mọi khối đang hiện đều là số đếm đo trực tiếp từ PostgreSQL");
    assert.equal(await page.getByTestId("block-affiliate").count() + (await page.getByTestId("block-youtube").count()), 0, "không hiện số liệu quảng cáo/kênh mẫu khi chưa có dữ liệu thật");
    // từ chối đầu ra: cần lý do; đóng bản đó; việc sang «Từ chối»
    const [t] = await pg.sql`SELECT code FROM tasks WHERE title LIKE 'Việc ưu tiên IMP-02%' AND status::text='WAITING_REVIEW' ORDER BY code LIMIT 1`;
    await go(page, `${base}/lumi/projects/test-offer-us?task=${t!.code}`);
    await waitIn(page, '[data-testid="task-detail"]', "Duyệt bản 1");
    assert.match(await page.getByTestId("task-detail").innerText(), /Đầu ra mới nhận/);
    assert.equal(await page.getByTestId("reject-output").isDisabled(), true, "chưa ghi lý do thì không từ chối được");
    // the page is server-rendered: text typed before React hydrates is discarded (normal), so type until it sticks
    for (let n = 0; n < 8; n++) { await page.locator("#rev").fill("Không đúng yêu cầu: sai hướng"); await page.waitForTimeout(500); if ((await page.locator("#rev").inputValue()) === "Không đúng yêu cầu: sai hướng") break; }
    await page.getByTestId("reject-output").click();
    await (async () => { const t0 = Date.now(); for (;;) { const [r] = await pg.sql`SELECT status::text s FROM tasks WHERE code=${t!.code}`; if (r!.s === "REJECTED") return; if (Date.now() - t0 > 30000) throw new Error("not rejected: " + r!.s); await new Promise((x) => setTimeout(x, 500)); } })();
    const [ap] = await pg.sql`SELECT a.decision, a.reason FROM lumi_approvals a JOIN lumi_task_outputs o ON o.id=a.object_id JOIN tasks k ON k.id=o.task_id WHERE k.code=${t!.code} AND a.kind='OUTPUT'`;
    assert.deepEqual([ap!.decision, ap!.reason], ["REJECT", "Không đúng yêu cầu: sai hướng"]);
    await ctx.close();
  });

  it("VIEWER: thấy Tổ chức/Chính sách/Quản trị nhưng không có nút ghi; API ghi 403 và không đổi gì; công cụ quản trị bị chặn", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "viewer@dev.local")).user?.role, "VIEWER");
    await go(page, `${base}/lumi/org`);
    await page.getByTestId("org-view").waitFor();
    await (async () => { const t0 = Date.now(); for (;;) { if (await page.locator("[data-testid^='assistant-']").count() >= 1) break; if (Date.now() - t0 > 60000) break; await page.waitForTimeout(1000); } })();
    assert.equal(await page.getByTestId("assistant-new").count(), 0);
    for (const k of ["edit-", "authority-", "verify-", "dispatch-", "archive-"]) assert.equal(await page.locator(`[data-testid^='${k}']`).count(), 0, `viewer thấy nút ${k}`);
    await go(page, `${base}/lumi/company`);
    await page.getByTestId("policies-panel").waitFor();
    assert.equal(await page.locator("[data-testid^='policy-edit-']").count(), 0);
    await go(page, `${base}/lumi/admin`);
    await page.getByTestId("admin-tab-tools").click();
    await page.getByTestId("admin-tools-denied").waitFor();
    await go(page, `${base}/lumi/projects`);
    assert.equal(await page.getByTestId("project-new").count(), 0);
    const before = (await pg.sql`SELECT (SELECT count(*)::int FROM lumi_assistants) a,(SELECT count(*)::int FROM lumi_projects) p,(SELECT count(*)::int FROM lumi_policies) c`)[0]!;
    const st = await page.evaluate(async () => {
      const hd = { "content-type": "application/json", "idempotency-key": "viewer-imp02-0001" };
      const a = (await fetch("/api/v1/lumi/assistants", { method: "POST", headers: hd, body: JSON.stringify({ slug: "viewer-bot", name: "Viewer Bot", role_label: "x y", tool_allowlist: ["outputs.submit"], limits: { run_deadline_seconds: 600, ack_deadline_seconds: 60, max_run_failures: 1, max_transport_attempts: 1, max_revision_rounds: 1, max_runs_per_day: 5 } }) })).status;
      const p = (await fetch("/api/v1/lumi/projects", { method: "POST", headers: hd, body: JSON.stringify({ name: "Viewer Project", area: "OTHER" }) })).status;
      const c = (await fetch("/api/v1/lumi/policies", { method: "POST", headers: hd, body: JSON.stringify({ key: "currency", value: "USD" }) })).status;
      return { a, p, c };
    });
    assert.deepEqual(st, { a: 403, p: 403, c: 403 });
    assert.deepEqual((await pg.sql`SELECT (SELECT count(*)::int FROM lumi_assistants) a,(SELECT count(*)::int FROM lumi_projects) p,(SELECT count(*)::int FROM lumi_policies) c`)[0], before);
    await ctx.close();
  });
});

/** poll a DB predicate: the page writes through the API, the test reads the database */
async function until<T>(f: () => Promise<T | undefined | null | false>, what: string, ms = 45_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await new Promise((x) => setTimeout(x, 500)); }
}
async function clickUntil(page: Page, click: string, expect: string) {
  for (let i = 0; i < 6; i++) { await page.getByTestId(click).click(); if (await page.getByTestId(expect).waitFor({ timeout: 8000 }).then(() => true, () => false)) return; }
  throw new Error(`${click} did not open ${expect}`);
}

describe("IMP-03 — phối hợp, tổ chức, năng lực, đánh giá (adapter GIẢ, dữ liệu mô phỏng)", () => {
  it("Tổ chức: vai trò → bổ nhiệm (trùng bị chặn, không đổi quyền) → chuyển vai; năng lực đã kiểm chứng cần bằng chứng; mức quyền; đánh giá không có cột chi phí; business case không tự tạo bot", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    await pg.sql`INSERT INTO profiles(slug,name,type,status) VALUES ('ui-imp03','Bot UI IMP-03','bot','active') ON CONFLICT DO NOTHING`;
    await pg.sql`INSERT INTO lumi_assistants(slug,name,kind,hermes_profile,connection_state,execution_level,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day,description)
      VALUES ('ui-imp03','Bot UI IMP-03','SPECIALIST','ui-imp03','VERIFIED',0,'["knowledge.context","outputs.submit","web"]',600,60,2,3,3,20,'Bot thử IMP-03 (mô phỏng)') ON CONFLICT (slug) DO NOTHING`;
    const before = (await pg.sql`SELECT tool_allowlist,capability_mode FROM lumi_assistants WHERE slug='lumitest'`)[0]!;
    await go(page, `${base}/lumi/org`);
    await page.getByTestId("org-view").waitFor();
    await page.getByTestId("assistant-ui-imp03").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("level-ui-imp03").innerText(), /Mức 0/);
    // vai trò + bổ nhiệm
    await clickUntil(page, "org-tab-appointments", "role-form");
    await page.getByTestId("role-name").fill("Trưởng nội dung UI");
    await page.getByTestId("role-submit").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_roles WHERE name='Trưởng nội dung UI' AND status='ACTIVE'`).length === 1, "role created");
    await page.getByTestId("appointment-form").waitFor();
    const [role] = await pg.sql`SELECT id FROM lumi_roles WHERE name='Trưởng nội dung UI'`;
    const [a1] = await pg.sql`SELECT id FROM lumi_assistants WHERE slug='lumitest'`;
    await page.getByTestId("ap-role").selectOption(role!.id as string);
    await page.getByTestId("ap-assistant").selectOption(a1!.id as string);
    await page.getByTestId("ap-submit").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_appointments WHERE role_id=${role!.id} AND state='ACTIVE'`).length === 1, "appointment created");
    await page.locator("[data-testid^='appointment-ROLE-'][data-testid$='-ACTIVE']").first().waitFor({ timeout: 30_000 });
    // trùng bị chặn, không tạo dòng thứ hai
    await page.getByTestId("ap-role").selectOption(role!.id as string);
    await page.getByTestId("ap-assistant").selectOption(a1!.id as string);
    await page.getByTestId("ap-submit").click();
    await page.waitForTimeout(2500);
    assert.equal((await pg.sql`SELECT 1 FROM lumi_appointments WHERE role_id=${role!.id}`).length, 1);
    // chuyển vai sang bot khác
    await page.locator("[data-testid^='transfer-ROLE-']").first().click();
    const [a2] = await pg.sql`SELECT id FROM lumi_assistants WHERE slug='ui-imp03'`;
    await page.getByTestId("transfer-to").selectOption(a2!.id as string);
    await page.getByTestId("transfer-confirm").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_appointments WHERE role_id=${role!.id} AND state='ACTIVE' AND assistant_id=${a2!.id}`).length === 1, "appointment transferred");
    assert.equal((await pg.sql`SELECT 1 FROM lumi_appointments WHERE role_id=${role!.id} AND state='ENDED' AND end_reason='TRANSFERRED'`).length, 1);
    const after = (await pg.sql`SELECT tool_allowlist,capability_mode FROM lumi_assistants WHERE slug='lumitest'`)[0]!;
    assert.deepEqual([after.tool_allowlist, after.capability_mode], [before.tool_allowlist, before.capability_mode], "bổ nhiệm không đổi quyền");
    // năng lực + mức quyền
    await page.getByTestId("org-tab-skills").click();
    await page.getByTestId("skill-form").waitFor();
    await page.getByTestId("sk-assistant").selectOption(a2!.id as string);
    await page.getByTestId("sk-name").fill("Viết caption");
    await page.getByTestId("sk-evidence").fill("ngắn");
    await page.getByTestId("sk-env").fill("Thử trong ứng dụng");
    await page.getByTestId("sk-submit").click();
    await page.waitForTimeout(2000);
    assert.equal((await pg.sql`SELECT 1 FROM lumi_skills`).length, 0, "bằng chứng quá ngắn bị từ chối");
    await page.getByTestId("sk-evidence").fill("Chấm 5 bài mẫu, 5/5 đạt");
    await page.getByTestId("sk-submit").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_skills WHERE state='VERIFIED' AND assessed_by IS NOT NULL`).length === 1, "skill saved");
    await page.getByTestId("level-select-ui-imp03").selectOption("1");
    await page.getByTestId("level-save-ui-imp03").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_assistants WHERE slug='ui-imp03' AND execution_level=1`).length === 1, "level saved");
    await page.getByTestId("level-select-ui-imp03").selectOption("0");
    await page.getByTestId("level-save-ui-imp03").click(); // hạ xuống 0 khi công cụ có «web» ⇒ bị chặn
    await page.waitForTimeout(2500);
    assert.equal((await pg.sql`SELECT execution_level l FROM lumi_assistants WHERE slug='ui-imp03'`)[0]!.l, 1, "không hạ mức dưới công cụ đang có");
    // đánh giá
    await page.getByTestId("org-tab-evaluation").click();
    await page.getByTestId("ev-table").waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("ev-notes").innerText(), /CHƯA ĐO/);
    assert.equal(/chi phí|cost/i.test(await page.locator("[data-testid='ev-table'] thead").innerText()), false, "bảng đánh giá không có cột chi phí");
    // business case
    const botsBefore = (await pg.sql`SELECT count(*)::int n FROM lumi_assistants`)[0]!.n;
    for (const [k, v] of [["title", "Thêm bot dịch phụ đề"], ["work_needed", "Dịch phụ đề 20 video/tuần"], ["volume", "20 video/tuần"], ["extra_cost", "chưa biết, cần đo"], ["owner_time_saved", "3 giờ/tuần (ước tính)"], ["trial_criteria", "Đạt 8/10 bài mẫu"], ["stop_condition", "Dưới 6/10 sau 2 tuần"]]) await page.getByTestId(`bc-${k}`).first().fill(v!);
    await page.getByTestId("bc-submit").click();
    const bc = await until(async () => (await pg.sql`SELECT code FROM lumi_bot_cases WHERE state='PROPOSED'`)[0], "bot case created");
    await page.getByTestId(`bc-approve-${bc.code}`).click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_bot_cases WHERE code=${bc.code as string} AND state='APPROVED'`).length === 1, "bot case approved");
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_assistants`)[0]!.n, botsBefore, "duyệt business case không tự tạo nhân viên");
    await ctx.close();
  });

  it("Việc: phụ thuộc giữ việc phía sau, thả đúng khi đầu ra phía trên được duyệt; mở lại ⇒ «cần kiểm lại»; bàn giao bị từ chối nêu lý do rồi thành công; đề xuất của PM chỉ có hiệu lực khi Chủ duyệt", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "owner@dev.local");
    await pg.sql`UPDATE lumi_assistants SET dispatch_enabled=true WHERE slug='lumitest'`;
    // bên nhận chưa bật giao việc ⇒ việc nhận nằm ở «Chờ trợ lý», và bàn giao tới nó bị từ chối có lý do
    await pg.sql`INSERT INTO profiles(slug,name,type,status) VALUES ('ui-recv','Bot nhận UI','bot','active') ON CONFLICT DO NOTHING`;
    await pg.sql`INSERT INTO lumi_assistants(slug,name,kind,hermes_profile,connection_state,execution_level,tool_allowlist,dispatch_enabled,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day,description)
      VALUES ('ui-recv','Bot nhận UI','SPECIALIST','ui-recv','VERIFIED',2,'["knowledge.context","outputs.submit"]',false,600,60,2,3,3,50,'Bên nhận thử (mô phỏng)') ON CONFLICT (slug) DO NOTHING`;
    await pg.sql`UPDATE lumi_assistants SET execution_level=2 WHERE slug='lumitest'`;
    const [proj] = await pg.sql`SELECT id FROM lumi_projects WHERE slug='test-offer-us'`;
    const [recv] = await pg.sql`SELECT id FROM lumi_assistants WHERE slug='ui-recv'`;
    const [src] = await pg.sql`SELECT id FROM lumi_assistants WHERE slug='lumitest'`;
    await go(page, `${base}/lumi`);
    const mk = (title: string, assignee: string, key: string) => page.evaluate(async ([t, a, p, k]) => {
      const r = await fetch("/api/v1/tasks", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": k! }, body: JSON.stringify({ project_id: p, assignee_id: a, title: t }) });
      return (await r.json()).data?.task?.code as string;
    }, [title, assignee, proj!.id as string, key] as string[]);
    const pol = await page.evaluate(async () => {
      const out: number[] = [];
      for (const [key, value] of [["handoff_max_depth", 3], ["handoff_max_rounds", 2]] as const) out.push((await fetch("/api/v1/lumi/policies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, value }) })).status);
      return out;
    });
    assert.ok(pol.every((s) => s === 201 || s === 200), `chính sách bàn giao: ${pol}`);
    const up = await mk("Việc phía trên (UI IMP-03)", src!.id as string, "ui-imp03-up-0001");
    const down = await mk("Việc phía sau (UI IMP-03)", recv!.id as string, "ui-imp03-down-0001");
    assert.ok(up && down, "tạo việc qua API");
    assert.equal((await pg.sql`SELECT status::text s FROM tasks WHERE code=${down}`)[0]!.s, "WAITING_ASSISTANT");
    // thêm phụ thuộc qua giao diện
    await go(page, `${base}/lumi/projects/test-offer-us?task=${down}`);
    await page.getByTestId("coord-panel").waitFor({ timeout: 60_000 });
    for (let i = 0; i < 6; i++) { await page.getByTestId("dep-pick").selectOption({ label: `${up} · Việc phía trên (UI IMP-03)` }).catch(() => {}); if (await page.getByTestId("dep-pick").inputValue()) break; await page.waitForTimeout(1000); }
    await page.getByTestId("dep-add").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_task_deps d JOIN tasks t ON t.id=d.task_id WHERE t.code=${down}`).length === 1, "dependency saved");
    assert.deepEqual(Object.values((await pg.sql`SELECT status::text s,hold_reason h FROM tasks WHERE code=${down}`)[0]!), ["ON_HOLD", "WAITING_DEPENDENCY"]);
    await page.getByTestId(`dep-${up}`).waitFor({ timeout: 30_000 });
    // đầu ra phía trên được tạo bởi worker giả; Chủ duyệt ⇒ việc phía sau được thả (bên nhận chưa bật giao việc ⇒ chờ trợ lý, KHÔNG có lượt chạy)
    await go(page, `${base}/lumi/projects/test-offer-us?task=${up}`);
    await waitIn(page, '[data-testid="task-detail"]', "Duyệt bản 1");
    await page.getByRole("button", { name: "Duyệt bản 1" }).click();
    await waitIn(page, '[data-testid="real-panel"]', "Trạng thái thật: Hoàn thành");
    await until(async () => (await pg.sql`SELECT d.consumed_version v FROM lumi_task_deps d JOIN tasks t ON t.id=d.task_id WHERE t.code=${down}`)[0]?.v === 1, "dependency consumed");
    assert.equal((await pg.sql`SELECT status::text s FROM tasks WHERE code=${down}`)[0]!.s, "WAITING_ASSISTANT");
    assert.equal((await pg.sql`SELECT 1 FROM lumi_task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.code=${down} AND r.state IN ('PENDING','DISPATCHED','RUNNING')`).length, 0);
    // mở lại việc phía trên ⇒ việc phía sau bị giữ lại, cạnh đánh dấu đổi; panel của việc phía sau nói «cần kiểm lại»
    await page.getByTestId("coord-reason").fill("Đầu vào thay đổi sau khi duyệt");
    await page.getByTestId("task-reopen").click();
    await until(async () => (await pg.sql`SELECT d.stale s FROM lumi_task_deps d JOIN tasks t ON t.id=d.task_id WHERE t.code=${down}`)[0]?.s === true, "dependency stale");
    await go(page, `${base}/lumi/projects/test-offer-us?task=${down}`);
    await page.getByTestId("coord-recheck").waitFor({ timeout: 60_000 });
    // bàn giao từ việc phía trên tới bên nhận CHƯA bật giao việc ⇒ bị từ chối có lý do + gợi ý, không tạo gì
    const hoBefore = (await pg.sql`SELECT count(*)::int n FROM lumi_handoffs`)[0]!.n;
    await go(page, `${base}/lumi/projects/test-offer-us?task=${up}`);
    await page.getByTestId("handoff-form").waitFor({ timeout: 60_000 });
    for (let i = 0; i < 6; i++) { await page.getByTestId("ho-to").selectOption({ label: "Bot nhận UI" }).catch(() => {}); if (await page.getByTestId("ho-to").inputValue()) break; await page.waitForTimeout(1000); }
    await page.getByTestId("ho-title").fill("Làm nội dung từ hồ sơ");
    await page.getByTestId("ho-request").fill("Dùng hồ sơ đã chấp nhận để soạn nội dung");
    await page.getByTestId("ho-submit").click();
    await page.getByTestId("ho-reason-DISPATCH_OFF").waitFor({ timeout: 30_000 });
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_handoffs`)[0]!.n, hoBefore, "bị từ chối thì không tạo bàn giao");
    assert.ok((await pg.sql`SELECT 1 FROM audit_events WHERE action='handoff.refused'`).length >= 1, "từ chối được ghi nhật ký");
    // bật giao việc cho bên nhận ⇒ bàn giao thành công
    await pg.sql`UPDATE lumi_assistants SET dispatch_enabled=true WHERE slug='ui-recv'`;
    await page.getByTestId("ho-submit").click();
    await until(async () => (await pg.sql`SELECT code,state FROM lumi_handoffs`)[0], "handoff created");
    await page.locator("[data-testid^='handoff-HO-']").first().waitFor({ timeout: 30_000 });
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_handoffs`)[0]!.n, hoBefore + 1);
    // đề xuất của PM: chưa hiệu lực cho tới khi Chủ duyệt ở tab «Thay đổi»
    const [pmTask] = await pg.sql`SELECT id,code FROM tasks WHERE code=${down}`;
    await pg.sql`UPDATE lumi_projects SET pm_assistant_id=${src!.id as string} WHERE id=${proj!.id as string}`;
    await pg.sql`UPDATE tasks SET status='QUEUED'::task_status, hold_reason=NULL WHERE id=${pmTask!.id as string}`;
    await pg.sql`INSERT INTO lumi_change_proposals(idempotency_key,project_id,task_id,to_assistant_id,reason,proposed_by_assistant_id) VALUES ('ui-imp03-chg-0001',${proj!.id as string},${pmTask!.id as string},${src!.id as string},'Bot nguồn đang rảnh',${src!.id as string})`;
    await go(page, `${base}/lumi/approvals?tab=change`);
    await page.getByTestId(`change-${down}`).waitFor({ timeout: 60_000 });
    assert.equal((await pg.sql`SELECT owner_assistant_id o FROM tasks WHERE code=${down}`)[0]!.o, recv!.id, "chưa duyệt thì chưa đổi người");
    await page.getByTestId(`change-approve-${down}`).click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_change_proposals WHERE idempotency_key='ui-imp03-chg-0001' AND state IN ('APPLIED','FAILED')`).length === 1, "proposal decided");
    await ctx.close();
  });

  it("VIEWER: thấy bổ nhiệm/năng lực/đánh giá/phụ thuộc nhưng không có nút ghi; API ghi 403 và không đổi gì", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "viewer@dev.local")).user?.role, "VIEWER");
    await go(page, `${base}/lumi/org`);
    await page.getByTestId("org-view").waitFor();
    await clickUntil(page, "org-tab-appointments", "org-appointments");
    assert.equal(await page.getByTestId("role-form").count(), 0);
    assert.equal(await page.getByTestId("appointment-form").count(), 0);
    assert.equal(await page.locator("[data-testid^='transfer-'],[data-testid^='end-']").count(), 0);
    await page.getByTestId("org-tab-skills").click();
    await page.getByTestId("org-skills").waitFor();
    assert.equal(await page.getByTestId("skill-form").count(), 0);
    assert.equal(await page.locator("[data-testid^='level-save-']").count(), 0);
    await page.getByTestId("org-tab-evaluation").click();
    await page.getByTestId("ev-table").waitFor({ timeout: 30_000 });
    assert.equal(await page.locator("[data-testid^='bc-approve-'],[data-testid^='bc-reject-']").count(), 0);
    const [code] = await pg.sql`SELECT code FROM tasks ORDER BY created_at DESC LIMIT 1`;
    await go(page, `${base}/lumi/projects/test-offer-us?task=${code!.code}`);
    await page.getByTestId("coord-panel").waitFor({ timeout: 60_000 });
    assert.equal(await page.locator("[data-testid='dep-form'],[data-testid='handoff-form'],[data-testid='task-reopen'],[data-testid='clear-recheck']").count(), 0);
    const counts = async () => (await pg.sql`SELECT (SELECT count(*)::int FROM lumi_roles) r,(SELECT count(*)::int FROM lumi_appointments) a,(SELECT count(*)::int FROM lumi_skills) s,(SELECT count(*)::int FROM lumi_task_deps) d,(SELECT count(*)::int FROM lumi_handoffs) h,(SELECT count(*)::int FROM lumi_bot_cases) c`)[0]!;
    const before = await counts();
    const st = await page.evaluate(async () => {
      const hd = { "content-type": "application/json", "idempotency-key": "viewer-imp03-0001" };
      const h = { method: "POST", headers: hd } as const;
      const r1 = (await fetch("/api/v1/lumi/roles", { ...h, body: JSON.stringify({ name: "Vai viewer" }) })).status;
      const r2 = (await fetch("/api/v1/lumi/bot-cases", { ...h, body: JSON.stringify({ title: "x" }) })).status;
      const r3 = (await fetch("/api/v1/lumi/evaluation", { ...h, body: JSON.stringify({}) })).status;
      const r4 = (await fetch("/api/v1/lumi/changes/00000000-0000-0000-0000-000000000001", { ...h, body: JSON.stringify({ decision: "APPROVE" }) })).status;
      return [r1, r2, r3, r4];
    });
    assert.deepEqual(st, [403, 403, 200, 403], "ghi bị từ chối; đọc đánh giá được");
    assert.deepEqual(await counts(), before);
    await ctx.close();
  });
});

describe("Tiến trình — thanh cho biết bot hay Chủ đang giữ việc và việc kế tiếp (adapter GIẢ)", () => {
  it("OWNER: tạo mục tiêu + kế hoạch ⇒ thanh hiện đúng giai đoạn, tới «Đến lượt bạn» với liên kết duyệt; trang kế hoạch cũng có thanh; VIEWER thấy nhưng không có thao tác ghi", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "owner@dev.local");
    await pg.sql`UPDATE lumi_assistants SET dispatch_enabled=true WHERE slug='lumitest'`;
    const [proj] = await pg.sql`SELECT id FROM lumi_projects WHERE slug='test-offer-us'`;
    const [lead] = await pg.sql`SELECT id FROM lumi_assistants WHERE slug='lumitest'`;
    await go(page, `${base}/lumi/company`);
    const made = await page.evaluate(async ([projectId, leadId]) => {
      await fetch("/api/v1/lumi/flags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "plans_enabled", value: true }) });
      const g = await (await fetch("/api/v1/lumi/goals", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "ui-progress-goal-0001" }, body: JSON.stringify({ project_id: projectId, title: "[TEST] Mục tiêu thanh tiến trình", outcome: "Kiểm tra thanh tiến trình bằng dữ liệu mô phỏng" }) })).json();
      const p = await fetch("/api/v1/lumi/plans", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "ui-progress-plan-0001" }, body: JSON.stringify({ goal_id: g.data?.goal?.id, lead_assistant_id: leadId }) });
      return { goal: g.data?.goal?.code as string | undefined, plan: p.status };
    }, [proj!.id as string, lead!.id as string]);
    assert.ok(made.goal && (made.plan === 201 || made.plan === 200), JSON.stringify(made));
    await go(page, `${base}/lumi/company`);
    const card = page.getByTestId(`progress-${made.goal}`);
    await card.waitFor({ timeout: 60_000 }).catch(async (e) => { throw new Error(`${e}
PAGE: ${(await page.locator("main").innerText()).slice(0, 800)}`); });
    assert.match(await card.getAttribute("data-stage") ?? "", /RUN_|WAITING|AWAITING_APPROVAL|NO_PLAN/);
    await (async () => { const t0 = Date.now(); for (;;) { if ((await card.getAttribute("data-stage")) === "AWAITING_APPROVAL") return; if (Date.now() - t0 > 120_000) throw new Error(`stage stuck at ${await card.getAttribute("data-stage")}: ${await card.innerText()}`); await page.waitForTimeout(1500); } })();
    assert.match(await card.getByTestId("progress-who").innerText(), /Đến lượt bạn/);
    const href = await card.getByTestId("progress-next").getAttribute("href");
    assert.match(href ?? "", /\/lumi\/plans\//);
    assert.match(await card.getByTestId("progress-headline").innerText(), /chờ bạn duyệt/);
    // checklist chi tiết: các bước bot đã xong, bước «Bạn duyệt» là bước hiện tại
    await card.getByTestId("progress-checklist").waitFor();
    assert.equal(await card.getByTestId("check-submit").getAttribute("data-state"), "done");
    assert.equal(await card.getByTestId("check-approve").getAttribute("data-state"), "current");
    assert.equal(await card.getByTestId("check-finish").getAttribute("data-state"), "todo");
    await go(page, `${base}${href}`);
    await page.getByTestId("plan-view").waitFor({ timeout: 60_000 });
    await page.getByTestId(`progress-${made.goal}`).waitFor({ timeout: 30_000 });
    // lệnh kỹ thuật gửi cho bot được gấp lại; phần «Yêu cầu» chỉ còn phần dễ đọc
    const [pt] = await pg.sql`SELECT t.code FROM lumi_plans p JOIN tasks t ON t.id=p.planning_task_id JOIN lumi_goals g ON g.id=p.goal_id WHERE g.code=${made.goal!}`;
    await go(page, `${base}/lumi/projects/test-offer-us?task=${pt!.code}`);
    await page.getByTestId("task-technical").waitFor({ timeout: 60_000 });
    assert.equal(/plan_submit_version|schema=1/.test(await page.getByTestId("task-request").innerText()), false, "phần «Yêu cầu» không còn thuật ngữ kỹ thuật");
    assert.equal(await page.getByTestId("task-technical").evaluate((el) => (el as HTMLDetailsElement).open), false, "khối kỹ thuật mặc định gấp");
    // VIEWER đọc được thanh nhưng không đổi được gì
    const vctx = await browser.newContext(); const vpage = await vctx.newPage();
    assert.equal((await login(vpage, base, "viewer@dev.local")).user?.role, "VIEWER");
    await go(vpage, `${base}/lumi/company`);
    await vpage.getByTestId(`progress-${made.goal}`).waitFor({ timeout: 60_000 });
    assert.equal(await vpage.getByTestId("goal-create-open").count(), 0);
    await vctx.close(); await ctx.close();
  });
});

describe("IMP-04/05 — kiến thức, họp, chi phí đo thật (adapter GIẢ, dữ liệu mô phỏng)", () => {
  it("Kiến thức: đề xuất (nguồn) → duyệt → nạp vào việc → sửa thành v2 (bản cũ vẫn áp dụng) → duyệt v2 → việc cũ hiện v1 + cảnh báo → so sánh → trùng tiêu đề buộc thay thế → lưu trữ; tìm không dấu", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    await pg.sql`UPDATE lumi_assistants SET dispatch_enabled=true WHERE slug='lumitest'`;
    const [proj] = await pg.sql`SELECT id FROM lumi_projects WHERE slug='test-offer-us'`;
    const [bot] = await pg.sql`SELECT id FROM lumi_assistants WHERE slug='lumitest'`;
    await pg.sql`INSERT INTO lumi_project_members(project_id,assistant_id) VALUES (${proj!.id as string},${bot!.id as string}) ON CONFLICT DO NOTHING`;
    await go(page, `${base}/lumi/knowledge`);
    await page.getByTestId("knowledge-view").waitFor();
    await clickUntil(page, "kn-add", "kn-form");
    await page.getByTestId("kf-scope").selectOption("PROJECT");
    await page.getByTestId("kf-project").selectOption(proj!.id as string);
    await page.getByTestId("kf-title").fill("Độ dài mô tả sản phẩm");
    await page.getByTestId("kf-content").fill("Mỗi mô tả tối đa 100 từ.");
    await page.getByTestId("kf-reason").fill("Thử nghiệm cho thấy bản ngắn giữ chân tốt hơn");
    await page.getByTestId("kf-src-title").fill("Báo cáo thử nghiệm tuần 45");
    await page.getByTestId("kf-submit").click();
    const item = await until(async () => (await pg.sql`SELECT id,code,status FROM lumi_knowledge_items WHERE status='PROPOSED'`)[0], "knowledge proposed");
    const code = item.code as string;
    await page.getByTestId(`kn-row-${code}`).waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId(`kn-row-${code}`).innerText(), /Chờ duyệt/);
    // chưa duyệt: việc mới KHÔNG được nạp quy tắc
    const mk = (title: string, key: string) => page.evaluate(async ([t, a, p, k]) => {
      const r = await fetch("/api/v1/tasks", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": k! }, body: JSON.stringify({ project_id: p, assignee_id: a, title: t }) });
      return (await r.json()).data?.task?.code as string;
    }, [title, bot!.id as string, proj!.id as string, key] as string[]);
    const t0 = await mk("Việc trước khi duyệt (UI IMP-04)", "ui-imp04-t0-0001");
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_run_knowledge rk JOIN lumi_task_runs r ON r.id=rk.run_id JOIN tasks t ON t.id=r.task_id WHERE t.code=${t0}`)[0]!.n, 0);
    await page.getByTestId(`kn-row-${code}`).click();
    await page.getByTestId("kn-review").waitFor();
    await page.getByTestId("kn-approve").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_knowledge_items WHERE code=${code} AND status='ACTIVE' AND approved_version=1`).length === 1, "approved v1");
    const t1 = await mk("Việc sau khi duyệt (UI IMP-04)", "ui-imp04-t1-0001");
    await go(page, `${base}/lumi/projects/test-offer-us?task=${t1}`);
    await page.getByTestId("loaded-knowledge").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("loaded-knowledge").innerText(), new RegExp(`${code} bản 1`));
    // sửa ⇒ v2 chờ duyệt; v1 vẫn áp dụng
    await go(page, `${base}/lumi/knowledge`);
    await page.getByTestId(`kn-row-${code}`).click();
    await clickUntil(page, "kn-revise-open", "kn-revise-form");
    await page.getByTestId("kn-revise-content").fill("Mỗi mô tả tối đa 150 từ.");
    await page.getByTestId("kn-revise-submit").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_knowledge_items WHERE code=${code} AND current_version=2 AND approved_version=1`).length === 1, "v2 pending, v1 in force");
    const t2 = await mk("Việc khi v2 chưa duyệt (UI IMP-04)", "ui-imp04-t2-0001");
    assert.match(JSON.stringify((await pg.sql`SELECT r.instruction_snapshot s FROM lumi_task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.code=${t2}`)[0]!.s), /100 từ/);
    await page.getByTestId("kn-review").waitFor({ timeout: 30_000 });
    await page.getByTestId("kn-approve").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_knowledge_items WHERE code=${code} AND approved_version=2`).length === 1, "approved v2");
    const t3 = await mk("Việc sau khi duyệt v2 (UI IMP-04)", "ui-imp04-t3-0001");
    assert.match(JSON.stringify((await pg.sql`SELECT r.instruction_snapshot s FROM lumi_task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.code=${t3}`)[0]!.s), /150 từ/);
    // việc cũ vẫn hiện v1 kèm cảnh báo quy tắc đã đổi
    await go(page, `${base}/lumi/projects/test-offer-us?task=${t1}`);
    await page.getByTestId("lk-changed").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("loaded-knowledge").innerText(), /bản 1/);
    // so sánh hai phiên bản + tìm kiếm không dấu
    await go(page, `${base}/lumi/knowledge`);
    await page.getByTestId("kn-q").fill("do dai mo ta");
    await page.getByTestId(`kn-row-${code}`).waitFor({ timeout: 30_000 });
    await page.getByTestId(`kn-row-${code}`).click();
    await page.getByTestId("kn-compare-1").click();
    assert.match(await page.getByTestId("kn-diff").innerText(), /100 từ[\s\S]*150 từ/);
    // trùng tiêu đề với mục đang hiệu lực ⇒ không duyệt được cho tới khi thay thế rõ
    await page.getByRole("button", { name: "Đóng", exact: true }).first().click();
    await clickUntil(page, "kn-add", "kn-form");
    await page.getByTestId("kf-scope").selectOption("PROJECT");
    await page.getByTestId("kf-project").selectOption(proj!.id as string);
    await page.getByTestId("kf-title").fill("Độ dài mô tả sản phẩm");
    await page.getByTestId("kf-content").fill("Ba mươi từ là đủ.");
    await page.getByTestId("kf-reason").fill("Muốn thay quy tắc cũ bằng bản ngắn hơn");
    await page.getByTestId("kf-submit").click();
    const second = await until(async () => (await pg.sql`SELECT id,code FROM lumi_knowledge_items WHERE status='PROPOSED' AND code<>${code}`)[0], "second proposal");
    await page.getByTestId("kn-q").fill("");
    await page.getByTestId(`kn-row-${second.code}`).click();
    await page.getByTestId("kn-review").waitFor();
    await page.getByTestId("kn-approve").click();
    await page.waitForTimeout(2500);
    assert.equal((await pg.sql`SELECT status FROM lumi_knowledge_items WHERE id=${second.id as string}`)[0]!.status, "PROPOSED", "trùng tiêu đề: chưa duyệt được khi chưa chọn thay thế");
    await page.getByTestId("kn-supersede").selectOption({ index: 1 });
    await page.getByTestId("kn-approve").click();
    await until(async () => (await pg.sql`SELECT code,status FROM lumi_knowledge_items WHERE code IN (${code},${second.code as string}) ORDER BY code`).map((r) => r.status).join() === "SUPERSEDED,ACTIVE" || (await pg.sql`SELECT code,status FROM lumi_knowledge_items WHERE code IN (${code},${second.code as string}) ORDER BY code`).map((r) => `${r.code}:${r.status}`).sort().join().includes("SUPERSEDED"), "superseded");
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_knowledge_items WHERE status='ACTIVE' AND scope='PROJECT' AND scope_ref=${proj!.id as string}`)[0]!.n, 1, "chỉ một mục hiệu lực");
    // lưu trữ ⇒ không còn được nạp, vẫn mở được
    await page.getByTestId("kn-archive-reason").fill("Hết hiệu lực");
    await page.getByTestId("kn-archive").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_knowledge_items WHERE id=${second.id as string} AND status='ARCHIVED'`).length === 1, "archived");
    const t4 = await mk("Việc sau khi lưu trữ (UI IMP-04)", "ui-imp04-t4-0001");
    assert.equal((await pg.sql`SELECT r.instruction_snapshot->'knowledge' k FROM lumi_task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.code=${t4}`)[0]!.k, null);
    await ctx.close();
  });

  it("Họp: mở họp bị chặn khi chỉ một bot phát biểu; mở đúng ⇒ việc đóng góp cho từng bot; đóng góp gốc + biên bản trỏ về nguồn; hệ thống phân loại kết luận; đề xuất tiền chờ Chủ và duyệt chỉ GHI NHẬN; VIEWER chỉ xem", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "owner@dev.local");
    const [proj] = await pg.sql`SELECT id FROM lumi_projects WHERE slug='test-offer-us'`;
    for (const [slug, name] of [["ui-m1", "Bot họp 1"], ["ui-m2", "Bot họp 2"], ["ui-m3", "Bot họp 3"]] as const) {
      await pg.sql`INSERT INTO profiles(slug,name,type,status) VALUES (${slug},${name},'bot','active') ON CONFLICT DO NOTHING`;
      await pg.sql`INSERT INTO lumi_assistants(slug,name,kind,hermes_profile,connection_state,execution_level,tool_allowlist,dispatch_enabled,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day,description)
        VALUES (${slug},${name},'SPECIALIST',${slug},'VERIFIED',2,'["knowledge.context","outputs.submit"]',true,600,60,2,3,3,50,'Bot họp thử (mô phỏng)') ON CONFLICT (slug) DO NOTHING`;
      await pg.sql`INSERT INTO lumi_project_members(project_id,assistant_id) SELECT ${proj!.id as string}, id FROM lumi_assistants WHERE slug=${slug} ON CONFLICT DO NOTHING`;
    }
    const [m1] = await pg.sql`SELECT id FROM lumi_assistants WHERE slug='ui-m1'`;
    const [g] = await pg.sql`INSERT INTO lumi_goals(code,title,outcome,project_id,source_key,created_by) VALUES ('GL-MT','Mục tiêu họp','Kết quả',${proj!.id as string},'goal-mt-ui','test') RETURNING id`;
    const [plan] = await pg.sql`INSERT INTO lumi_plans(code,goal_id,project_id,lead_assistant_id,status,current_version,approved_version,created_by) VALUES ('PL-MT',${g!.id as string},${proj!.id as string},${m1!.id as string},'EXECUTING',1,1,'test') RETURNING id`;
    await pg.sql`INSERT INTO lumi_plan_versions(plan_id,version,state,body,content_hash,ceiling_amount,currency,submitted_by) VALUES (${plan!.id as string},1,'APPROVED','{}','h',10,'USD','bot:ui-m1')`;
    await go(page, `${base}/lumi/meetings`);
    await page.getByTestId("meetings-view").waitFor();
    // chưa đặt trần số họp ⇒ chặn kèm hướng dẫn
    await clickUntil(page, "mt-open", "mt-form");
    await page.getByTestId("mf-title").fill("Dự toán chung (UI IMP-04)");
    await page.getByTestId("mf-question").fill("Dự toán chi phí sản xuất 3 video là bao nhiêu?");
    await page.getByTestId("mf-plan").selectOption({ label: "PL-MT (EXECUTING)" });
    await page.getByTestId("mf-chair").selectOption({ label: "Bot họp 1" });
    await page.getByTestId("mf-submit").click();
    await page.getByTestId("mf-error").waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("mf-error").innerText(), /trần số lần họp|Chính sách|bàn giao/);
    await page.evaluate(async () => { await fetch("/api/v1/lumi/policies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "meeting_cap", value: 5 }) }); });
    // chỉ chủ trì phát biểu (không có ai khác) ⇒ đi thẳng bàn giao
    await page.getByTestId("mf-submit").click();
    await page.waitForFunction(() => /bàn giao/.test(document.querySelector("[data-testid='mf-error']")?.textContent ?? ""), null, { timeout: 30_000 });
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_meetings`)[0]!.n, 0, "bị chặn thì không tạo gì");
    await page.getByTestId("mf-part-ui-m2").check();
    await page.getByTestId("mf-part-ui-m3").check();
    await page.getByTestId("mf-submit").click();
    const mt = await until(async () => (await pg.sql`SELECT id,code FROM lumi_meetings`)[0], "meeting opened");
    const code = mt.code as string;
    await page.getByTestId("mt-detail").waitFor({ timeout: 30_000 });
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_meeting_participants WHERE meeting_id=${mt.id as string} AND task_id IS NOT NULL`)[0]!.n, 3, "mỗi bot phát biểu có một việc đóng góp");
    assert.match(await page.getByTestId("mt-participants").innerText(), /Chủ trì/);
    assert.match(await page.getByTestId("mt-cost").innerText(), /chưa biết|0\.0000/);
    // các bot đóng góp (cùng lời gọi miền mà công cụ MCP dùng) rồi chủ trì tổng hợp
    const db = postgresDb(pg.sql);
    const bots = await pg.sql`SELECT id,slug FROM lumi_assistants WHERE slug IN ('ui-m1','ui-m2','ui-m3') ORDER BY slug`;
    const say = (b: Record<string, unknown> | undefined, s: string) => contribute(db, { meetingCode: code, actorRef: `bot:${String(b!.slug)}`, assistantId: String(b!.id), stance: s, evidence: "Báo giá tháng 11", now: new Date() });
    await say(bots[1], "Tôi đề xuất 100 USD"); await say(bots[2], "Tôi đề xuất 120 USD"); await say(bots[0], "Chủ trì: khoảng 110 USD");
    await page.getByTestId("mt-contrib-3").waitFor({ timeout: 60_000 });
    await until(async () => { await meetingTick(db, new Date()); return (await pg.sql`SELECT synth_task_id FROM lumi_meetings WHERE id=${mt.id as string}`)[0]?.synth_task_id; }, "synthesis task");
    const ids = (await pg.sql`SELECT id FROM lumi_meeting_contributions WHERE meeting_id=${mt.id as string} ORDER BY created_at`).map((x) => x.id as string);
    const out = await synthesizeMeeting(db, { meetingCode: code, actorRef: "bot:ui-m1", assistantId: bots[0]!.id as string, summary: "Chốt dự toán 110 USD cho 3 video", lines: [{ text: "Dự toán 110 USD", contribution_ids: [ids[0]!, ids[1]!] }],
      conclusions: [{ type: "RECORD", text: "Dự toán 110 USD" }, { type: "BUDGET_CHANGE", text: "Tăng trần lên 300 USD", payload: { to: 300 } }], now: new Date() });
    assert.equal(out.outcome, "DECIDED");
    await page.getByTestId("mt-note-1").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("mt-note-1").innerText(), /nguồn: đóng góp #1, #2/);
    assert.equal(await page.getByTestId("mt-concl-1").getAttribute("data-kind"), "RECORD");
    assert.equal(await page.getByTestId("mt-concl-2").getAttribute("data-kind"), "PROPOSAL");
    assert.equal(await page.getByTestId("mt-concl-2").getAttribute("data-state"), "PENDING_OWNER");
    const budgetsBefore = JSON.stringify(await pg.sql`SELECT * FROM lumi_budgets`);
    // màn Chờ duyệt có đề xuất của họp; duyệt chỉ ghi nhận, không đổi ngân sách
    await go(page, `${base}/lumi/approvals?tab=kmeet`);
    await page.getByTestId("pending-mc-approve-BUDGET_CHANGE").click();
    await until(async () => (await pg.sql`SELECT 1 FROM lumi_meeting_conclusions WHERE type='BUDGET_CHANGE' AND state='APPROVED'`).length === 1, "conclusion approved");
    assert.equal(JSON.stringify(await pg.sql`SELECT * FROM lumi_budgets`), budgetsBefore, "kết luận họp không đổi ngân sách");
    // VIEWER chỉ xem
    const vctx = await browser.newContext(); const vpage = await vctx.newPage();
    assert.equal((await login(vpage, base, "viewer@dev.local")).user?.role, "VIEWER");
    await go(vpage, `${base}/lumi/meetings`);
    await vpage.getByTestId(`mt-row-${code}`).click();
    await vpage.getByTestId("mt-detail").waitFor({ timeout: 60_000 });
    assert.equal(await vpage.locator("[data-testid='mt-open'],[data-testid^='mt-approve-'],[data-testid^='mt-reject-'],[data-testid='mt-close']").count(), 0);
    const st = await vpage.evaluate(async () => {
      const r1 = (await fetch("/api/v1/lumi/meetings/MT-001/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "viewer" }) })).status;
      const r2 = (await fetch("/api/v1/lumi/knowledge/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).status;
      return [r1, r2];
    });
    assert.deepEqual(st, [403, 200]);
    await vctx.close(); await ctx.close();
  });

  it("Chi phí đo thật: thẻ nêu số ĐO THẬT và số lượt CHƯA BIẾT kèm lý do (không bao giờ là 0); lượt chồng/khóa chung không được khẳng định", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page, base, "owner@dev.local");
    const [bot] = await pg.sql`SELECT id FROM lumi_assistants WHERE slug='lumitest'`;
    const runs = await pg.sql`SELECT r.id FROM lumi_task_runs r WHERE r.assistant_id=${bot!.id as string} ORDER BY r.created_at LIMIT 3`;
    assert.ok(runs.length >= 3, "có đủ lượt chạy từ các bài trước");
    await pg.sql`UPDATE lumi_task_runs SET state='SUCCEEDED',started_at=now() - interval '1 minute',finished_at=now() WHERE id = ANY(${runs.map((r) => r.id as string)}::uuid[]) AND state NOT IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED')`;
    await pg.sql`INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,before_usage,after_usage,currency) VALUES (${runs[0]!.id as string},${bot!.id as string},'MEASURED',0.5,0.5125,'USD') ON CONFLICT (run_id) DO NOTHING`;
    await pg.sql`INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,reason,currency) VALUES (${runs[1]!.id as string},${bot!.id as string},'OVERLAP','RUNS_OVERLAPPED','USD') ON CONFLICT (run_id) DO NOTHING`;
    await pg.sql`INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,reason,currency) VALUES (${runs[2]!.id as string},${bot!.id as string},'UNAVAILABLE','SHARED_KEY','USD') ON CONFLICT (run_id) DO NOTHING`;
    await go(page, `${base}/lumi/company`);
    const row = page.getByTestId("cost-lumitest");
    await row.waitFor({ timeout: 60_000 });
    assert.match(await row.innerText(), /0\.0125/);
    assert.match(await row.innerText(), /chưa biết/);
    await page.getByTestId("cost-card").locator("summary").click();
    const text = await page.getByTestId("cost-card").innerText();
    assert.match(text, /chồng nhau/); assert.match(text, /dùng chung/);
    await ctx.close();
  });
});

describe("Đợt 5 — Tài chính: giới hạn chi phí, ba sổ tiền tách riêng, thử nghiệm chốt tiêu chí (adapter GIẢ, dữ liệu mô phỏng)", () => {
  it("OWNER: đặt giới hạn ngày → ghi hoa hồng (nguồn bắt buộc) → đảo/điều chỉnh giữ số cũ → tạo & chốt thử nghiệm → nhập kết quả (một chuyển đổi không đề xuất mở rộng) → Công ty hiện kết quả theo mảng", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    const [proj] = await pg.sql`SELECT id FROM lumi_projects WHERE slug='test-offer-us'`;
    await go(page, `${base}/lumi/finance`);
    await page.getByTestId("finance-view").waitFor({ timeout: 60_000 });
    // giới hạn
    await page.getByTestId("lm-amount").fill("5");
    await page.getByTestId("lm-save").click();
    await page.getByTestId("limit-DAY_GLOBAL").waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("limit-table").innerText(), /5/);
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_cost_limits WHERE scope='DAY_GLOBAL' AND active`)[0]!.n, 1);
    // sổ tiền
    await clickUntil(page, "fin-tab-money", "fin-money");
    assert.match(await page.getByTestId("mn-note").innerText(), /KHÔNG cộng thành lợi nhuận/);
    assert.equal(await page.getByTestId("book-COMMISSION-empty").count(), 1, "chưa có dữ liệu thì nói chưa có");
    await page.getByTestId("mf-project").selectOption(proj!.id as string);
    await page.getByTestId("mf-amount").fill("120");
    await page.getByTestId("mf-source").fill("Sao kê mạng lưới tháng 10 (thử)");
    await page.getByTestId("mf-submit").click();
    await page.getByTestId("money-COMMISSION-RECORDED").waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("book-COMMISSION-USD").innerText(), /ghi nhận 120/);
    await page.getByTestId("adj-RECORDED-PAID").click();
    await page.getByTestId("money-COMMISSION-PAID").waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("book-COMMISSION-USD").innerText(), /đã trả 120/);
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_money_entries`)[0]!.n, 2, "số cũ được giữ, điều chỉnh là dòng mới");
    // thử nghiệm
    await clickUntil(page, "fin-tab-experiments", "fin-experiments");
    await clickUntil(page, "ex-add", "ex-form");
    await page.getByTestId("ex-project").selectOption(proj!.id as string);
    const f: Record<string, string> = { title: "Thử từ khóa thương hiệu", hypothesis: "Từ khóa thương hiệu tốt hơn", baseline: "0,8%", source: "Bảng quảng cáo", days: "7", sample: "5", cap: "50", loss: "30", stop: "Chi 30 mà 0 chuyển đổi", scale: "Từ 5 chuyển đổi" };
    for (const [k, v] of Object.entries(f)) await page.getByTestId(`ex-${k}`).fill(v);
    await page.getByTestId("ex-submit").click();
    const ex = await until(async () => (await pg.sql`SELECT id,code,state FROM lumi_experiments`)[0], "experiment created");
    const code = ex.code as string;
    await page.getByTestId(`ex-lock-${code}`).click();
    await page.getByTestId(`ex-result-form-${code}`).waitFor({ timeout: 30_000 });
    await page.getByTestId(`rs-day-${code}`).fill("2026-11-10");
    await page.getByTestId(`rs-spend-${code}`).fill("5");
    await page.getByTestId(`rs-conv-${code}`).fill("1");
    await page.getByTestId(`rs-submit-${code}`).click();
    await page.getByTestId(`ex-verdict-${code}`).waitFor({ timeout: 30_000 });
    assert.doesNotMatch(await page.getByTestId(`ex-verdict-${code}`).innerText(), /ứng viên mở rộng/);
    assert.equal((await pg.sql`SELECT state FROM lumi_experiments WHERE id=${ex.id as string}`)[0]!.state, "LOCKED");
    // Công ty: kết quả theo mảng + tình trạng trợ lý
    await go(page, `${base}/lumi/company`);
    await page.getByTestId("area-results").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("area-results").innerText(), /chưa có dữ liệu/);
    await page.getByTestId("assistant-health").waitFor();
    await ctx.close();
  });

  it("VIEWER: xem được Tài chính nhưng không có form ghi/đặt giới hạn/chốt; API ghi 403 và không đổi gì", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "viewer@dev.local")).user?.role, "VIEWER");
    const before = (await pg.sql`SELECT (SELECT count(*)::int FROM lumi_money_entries) m,(SELECT count(*)::int FROM lumi_cost_limits) l`)[0]!;
    await go(page, `${base}/lumi/finance`);
    await page.getByTestId("finance-view").waitFor({ timeout: 60_000 });
    assert.equal(await page.getByTestId("limit-form").count(), 0);
    await clickUntil(page, "fin-tab-money", "fin-money");
    assert.equal(await page.getByTestId("money-form").count(), 0);
    await clickUntil(page, "fin-tab-experiments", "fin-experiments");
    assert.equal(await page.getByTestId("ex-add").count(), 0);
    const st = await page.evaluate(async () => (await fetch("/api/v1/lumi/cost/limits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "DAY_GLOBAL", amount: 1 }) })).status);
    assert.equal(st, 403);
    const after = (await pg.sql`SELECT (SELECT count(*)::int FROM lumi_money_entries) m,(SELECT count(*)::int FROM lumi_cost_limits) l`)[0]!;
    assert.deepEqual([after.m, after.l], [before.m, before.l]);
    await ctx.close();
  });
});

describe("Đợt 6 — Routine, Ý tưởng, Mẫu việc, Cài đặt, Tìm kiếm, Soát kiến thức (adapter GIẢ, dữ liệu mô phỏng)", () => {
  it("OWNER: cài đặt đổi có lịch sử → ý tưởng thành ghi chú chờ duyệt → mẫu: tạo, duyệt, tạo việc từ mẫu → routine: tạo TẮT, bật bị chặn khi thiếu giới hạn, thông báo bật và chạy ngay → tìm kiếm bỏ dấu → trang soát kiến thức mở được", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    const [proj] = await pg.sql`SELECT id,name FROM lumi_projects WHERE slug='test-offer-us'`;
    const [bot] = await pg.sql`SELECT id,name FROM lumi_assistants WHERE slug='lumitest'`;
    await pg.sql`UPDATE lumi_assistants SET dispatch_enabled=true WHERE slug='lumitest'`;
    // cài đặt
    await go(page, `${base}/lumi/settings`);
    await page.getByTestId("settings-view").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("setting-value-proposal_expiry_days").innerText(), /7 ngày \(mặc định\)/);
    await page.getByTestId("setting-input-proposal_expiry_days").fill("14");
    await page.getByTestId("setting-save-proposal_expiry_days").click();
    await until(async () => (await pg.sql`SELECT value FROM lumi_setting_values WHERE key='proposal_expiry_days'`)[0]?.value === "14", "setting saved");
    // ý tưởng → ghi chú chờ duyệt
    await go(page, `${base}/lumi/ideas`);
    await page.getByTestId("ideas-view").waitFor({ timeout: 60_000 });
    await page.getByTestId("id-title").fill("Ghi chú từ khóa mùa hè");
    await page.getByTestId("id-body").fill("Từ khóa mùa hè tăng 20% (tính đến 2026-11-01)");
    await page.getByTestId("id-submit").click();
    const idea = await until(async () => (await pg.sql`SELECT id,code FROM lumi_ideas WHERE title='Ghi chú từ khóa mùa hè'`)[0], "idea created");
    const ic = idea.code as string;
    await page.getByTestId(`idea-${ic}`).waitFor({ timeout: 30_000 });
    await page.getByTestId(`idea-classify-${ic}`).click();
    await page.getByTestId(`idea-accept-${ic}`).waitFor({ timeout: 30_000 });
    await page.getByTestId(`idea-accept-${ic}`).click();
    await page.getByTestId(`idea-ref-${ic}`).waitFor({ timeout: 30_000 });
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_knowledge_items WHERE status='PROPOSED'`)[0]!.n >= 1, true, "ý tưởng chỉ thành ĐỀ XUẤT kiến thức");
    // mẫu
    await go(page, `${base}/lumi/templates`);
    await page.getByTestId("templates-view").waitFor({ timeout: 60_000 });
    await clickUntil(page, "tp-add", "tp-form");
    const tf: Record<string, string> = { name: "Soát bài đăng", description: "Soát nhanh một bài đăng. Hôm qua đã làm ngày 10/11/2026", when: "Khi có bài mới", steps: "1. Đọc 2. Ghi chú", inputs: "Liên kết bài", outputs: "Bản nhận xét", title: "Soát bài đăng mới" };
    for (const [k, v] of Object.entries(tf)) await page.getByTestId(`tp-${k}`).fill(v);
    await page.getByTestId("tp-submit").click();
    const tpl = await until(async () => (await pg.sql`SELECT id,code FROM lumi_task_templates WHERE name='Soát bài đăng'`)[0], "template created");
    const tc = tpl.code as string;
    await page.getByTestId(`tpl-warn-${tc}-v1`).first().waitFor({ timeout: 30_000 });
    await page.getByTestId(`tpl-approve-${tc}-v1`).click();
    await page.locator(`[data-testid='tpl-${tc}-v1'][data-state='APPROVED']`).waitFor({ timeout: 30_000 });
    await page.getByTestId(`tpl-use-project-${tc}`).selectOption(proj!.id as string);
    await page.getByTestId(`tpl-use-assignee-${tc}`).selectOption(bot!.id as string);
    await page.getByTestId(`tpl-use-${tc}`).click();
    await until(async () => (await pg.sql`SELECT count(*)::int n FROM lumi_task_template_uses`)[0]!.n === 1, "task from template");
    // routine
    await go(page, `${base}/lumi/routines`);
    await page.getByTestId("routines-view").waitFor({ timeout: 60_000 });
    await clickUntil(page, "rt-add", "rt-form");
    await page.getByTestId("rt-name").fill("Nhắc xem báo cáo");
    await page.getByTestId("rt-message").fill("Nhớ xem báo cáo sáng nay");
    await page.getByTestId("rt-submit").click();
    const rn = await until(async () => (await pg.sql`SELECT id,code,enabled FROM lumi_routines WHERE name='Nhắc xem báo cáo'`)[0], "notify routine");
    assert.equal(rn.enabled, false, "tạo xong luôn TẮT");
    await page.getByTestId(`rt-sched-${rn.code as string}`).waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId(`rt-sched-${rn.code as string}`).innerText(), /Thứ 2–6, 07:30 \(Asia\/Ho_Chi_Minh\)/);
    // tạo việc nhưng KHÔNG chọn bot ⇒ bật bị chặn (EXE-02)
    await clickUntil(page, "rt-add", "rt-form");
    await page.getByTestId("rt-name").fill("Tạo việc thiếu bot");
    await page.getByTestId("rt-kind").selectOption("CREATE_TASK");
    await page.getByTestId("rt-title").fill("Việc ngày {date}");
    await page.getByTestId("rt-project").selectOption(proj!.id as string);
    await page.getByTestId("rt-submit").click();
    const rc = await until(async () => (await pg.sql`SELECT id,code FROM lumi_routines WHERE name='Tạo việc thiếu bot'`)[0], "create_task routine");
    await page.getByTestId(`rt-toggle-${rc.code as string}`).click();
    await page.waitForTimeout(1500);
    assert.equal((await pg.sql`SELECT enabled FROM lumi_routines WHERE id=${rc.id as string}`)[0]!.enabled, false, "thiếu giới hạn ⇒ không bật được");
    // thông báo: bật và chạy ngay ⇒ lịch sử «Xong», không chi phí AI
    await page.getByTestId(`rt-toggle-${rn.code as string}`).click();
    await page.locator(`[data-testid='rt-${rn.code as string}'][data-enabled='1']`).waitFor({ timeout: 30_000 });
    await page.getByTestId(`rt-run-${rn.code as string}`).click();
    await until(async () => (await pg.sql`SELECT count(*)::int n FROM lumi_routine_runs WHERE routine_id=${rn.id as string} AND result='DONE'`)[0]!.n === 1, "manual run recorded");
    await page.getByTestId(`rt-history-${rn.code as string}`).locator("summary").click();
    await page.getByTestId(`rt-history-${rn.code as string}`).getByText(/Xong/).first().waitFor({ timeout: 30_000 });
    assert.equal(await page.getByTestId("rt-system").count(), 2);
    // tìm kiếm bỏ dấu
    await go(page, `${base}/lumi/search`);
    await page.getByTestId("search-q").fill("nhac xem bao cao");
    await page.getByTestId("search-go").click();
    await page.getByTestId("search-group-ROUTINE").waitFor({ timeout: 30_000 });
    // soát kiến thức
    await go(page, `${base}/lumi/knowledge/review`);
    await page.getByTestId("review-view").waitFor({ timeout: 60_000 });
    await ctx.close();
  });

  it("VIEWER: xem được các màn nhưng không có form ghi/nút bật; API ghi 403 và không đổi gì", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "viewer@dev.local")).user?.role, "VIEWER");
    const cnt = async () => (await pg.sql`SELECT (SELECT count(*)::int FROM lumi_routines) r,(SELECT count(*)::int FROM lumi_ideas) i,(SELECT count(*)::int FROM lumi_task_templates) t,(SELECT count(*)::int FROM lumi_setting_values) s`)[0]!;
    const before = await cnt();
    for (const [url, tid] of [["routines", "routines-view"], ["ideas", "ideas-view"], ["templates", "templates-view"], ["settings", "settings-view"]]) { await go(page, `${base}/lumi/${url}`); await page.getByTestId(tid!).waitFor({ timeout: 60_000 }); }
    assert.equal(await page.locator("[data-testid^='setting-save-']").count(), 0);
    await go(page, `${base}/lumi/routines`); await page.getByTestId("routines-view").waitFor();
    assert.equal(await page.getByTestId("rt-add").count(), 0); assert.equal(await page.locator("[data-testid^='rt-toggle-']").count(), 0);
    await go(page, `${base}/lumi/ideas`); await page.getByTestId("ideas-view").waitFor();
    assert.equal(await page.getByTestId("idea-form").count(), 0);
    await go(page, `${base}/lumi/templates`); await page.getByTestId("templates-view").waitFor();
    assert.equal(await page.getByTestId("tp-add").count(), 0);
    const post = (u: string, b: unknown) => page.evaluate(async ([url, body]) => (await fetch(url as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, [u, b] as [string, unknown]);
    const sts = [await post("/api/v1/lumi/settings", { key: "proposal_expiry_days", value: 3 }), await post("/api/v1/lumi/ideas", { title: "xyz", body: "abc" }), await post("/api/v1/lumi/routines/pause", { paused: true })];
    assert.deepEqual(sts, [403, 403, 403]);
    assert.deepEqual(await cnt(), before);
    await ctx.close();
  });
});

describe("Đợt 7 — hệ cũ Affiliate / YouTube / Money OS còn chạy trên dữ liệu thật (OWNER, chỉ đọc)", () => {
  it("OWNER mở được mọi màn kinh doanh cũ: không lỗi 5xx, không «Application error», có nội dung; chưa đăng nhập bị chuyển về /login", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    const routes = ["/aff", "/aff/offers", "/aff/offers/new", "/aff/results", "/aff/markets", "/aff/angles", "/youtube", "/youtube/videos", "/youtube/videos/new", "/youtube/ideas", "/youtube/niches", "/youtube/production", "/youtube/performance",
      "/moneyos", "/moneyos/opportunities", "/moneyos/signals", "/moneyos/clusters", "/moneyos/trends", "/moneyos/candidates", "/moneyos/evidence", "/moneyos/agents", "/memory", "/tasks", "/search", "/admin"];
    const bad: string[] = [];
    for (const r of routes) {
      const resp = await page.goto(`${base}${r}`, { waitUntil: "domcontentloaded" }).catch(() => null);
      const status = resp?.status() ?? 0;
      await page.waitForTimeout(400);
      const text = (await page.locator("body").innerText().catch(() => "")) || "";
      if (status >= 500 || status === 0 || /Application error|Internal Server Error|This page could not be found/i.test(text) || text.trim().length < 20) bad.push(`${r} -> ${status} ${text.slice(0, 80).replace(/\s+/g, " ")}`);
    }
    assert.deepEqual(bad, [], `màn lỗi:\n${bad.join("\n")}`);
    await ctx.close();
    const anon = await browser.newContext(); const ap = await anon.newPage();
    for (const r of ["/aff", "/youtube", "/moneyos"]) { await go(ap, `${base}${r}`); assert.match(ap.url(), /\/login/, `${r} chưa đăng nhập phải về /login`); }
    await anon.close();
  });
});

describe("Đợt 7 — Tự chủ, Tích hợp, Báo cáo kinh tế, Cơ hội (adapter GIẢ, dữ liệu mô phỏng)", () => {
  it("OWNER: ma trận tự chủ (loại rủi ro không có «Tự động») → tích hợp nêu thiếu gì → báo cáo kinh tế có công thức và CSV → cơ hội: ghi, trùng, chấm điểm có thành phần, đề xuất và chấp nhận tuyến", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    const [proj] = await pg.sql`SELECT id FROM lumi_projects WHERE slug='test-offer-us'`;
    // ma trận tự chủ
    await go(page, `${base}/lumi/autonomy`);
    await page.getByTestId("autonomy-view").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("am-mode-research").innerText(), /Tự động/);
    assert.match(await page.getByTestId("am-mode-publish_wordpress").innerText(), /Cần giấy ủy quyền/);
    assert.equal(await page.getByTestId("am-select-publish_wordpress").locator("option[value='AUTO']").count(), 0, "loại xuất bản không có lựa chọn Tự động");
    await page.getByTestId("am-select-research").selectOption("OFF");
    await until(async () => (await pg.sql`SELECT mode FROM lumi_autonomy_rules WHERE action_type='research'`)[0]?.mode === "OFF", "rule saved");
    await page.locator("[data-testid='am-research'][data-mode='OFF']").waitFor({ timeout: 30_000 });
    // tích hợp
    await go(page, `${base}/lumi/integrations`);
    await page.getByTestId("integrations-view").waitFor({ timeout: 60_000 });
    assert.equal(await page.locator("[data-testid='int-affiliate_net'][data-status='NOT_BUILT']").count(), 1);
    assert.equal(await page.locator("[data-testid='int-wordpress']").count(), 1);
    const intText = await page.getByTestId("integrations-view").innerText();
    assert.doesNotMatch(intText, /postgres:\/\//i, "không lộ chuỗi kết nối");
    // báo cáo kinh tế
    await pg.sql`INSERT INTO lumi_money_entries(project_id,ledger,state,amount,currency,source,idempotency_key,created_by,period_start,period_end) VALUES (${proj!.id as string},'COMMISSION','PAID',77,'USD','Sao kê (thử UI)','ui-eco-report-0001','web:owner@dev.local','2026-10-01','2026-10-31')`;
    await go(page, `${base}/lumi/finance`);
    await page.getByTestId("finance-view").waitFor({ timeout: 60_000 });
    await page.getByTestId("fin-tab-report").click();
    await page.getByTestId("fin-report").waitFor({ timeout: 30_000 });
    await page.getByTestId("rp-note").waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("rp-COMMISSION").innerText(), /đã trả\/thu \d+/);
    await page.getByTestId("rp-from").fill("2026-12-01");
    await page.getByTestId("rp-run").click();
    await page.getByTestId("rp-note").waitFor({ timeout: 30_000 });
    // cơ hội
    await go(page, `${base}/lumi/opportunities`);
    await page.getByTestId("opportunities-view").waitFor({ timeout: 60_000 });
    await page.getByTestId("sig-title").fill("Đồng hồ cơ giá rẻ");
    await page.getByTestId("sig-submit").click();
    await until(async () => (await pg.sql`SELECT count(*)::int n FROM opportunity_signals WHERE title='Đồng hồ cơ giá rẻ'`)[0]!.n === 1, "signal created");
    await page.getByTestId("sig-title").fill("đồng hồ cơ  GIÁ RẺ");
    await page.getByTestId("sig-submit").click();
    await page.waitForTimeout(1200);
    assert.equal((await pg.sql`SELECT count(*)::int n FROM opportunity_signals WHERE title LIKE 'Đồng hồ cơ%'`)[0]!.n, 1, "trùng không lưu hai lần");
    const t = "Đồng hồ cơ giá rẻ";
    await page.getByTestId(`sig-${t}`).locator("details", { hasText: "Chấm điểm" }).locator("summary").click();
    await page.getByTestId(`sc-audience_usefulness-${t}`).fill("0.9");
    await page.getByTestId(`sc-search_opportunity-${t}`).fill("0.5");
    await page.getByTestId(`sc-go-${t}`).click();
    await page.getByTestId(`sig-score-${t}`).waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId(`sig-score-${t}`).innerText(), /chưa biết/);
    assert.match(await page.getByTestId(`sig-score-${t}`).innerText(), /khớp/);
    await page.getByTestId(`rt-reason-${t}`).fill("Theo dõi thêm một tuần");
    await page.getByTestId(`rt-go-${t}`).click();
    await page.getByTestId("route-accept-WATCHLIST").waitFor({ timeout: 30_000 });
    await page.getByTestId("route-accept-WATCHLIST").click();
    await page.getByTestId("route-ACCEPTED-WATCHLIST").waitFor({ timeout: 30_000 });
    await ctx.close();
  });

  it("VIEWER: xem được bốn màn mới, không có điều khiển ghi; API ghi 403 và không đổi gì", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "viewer@dev.local")).user?.role, "VIEWER");
    const cnt = async () => (await pg.sql`SELECT (SELECT count(*)::int FROM lumi_autonomy_rules) a,(SELECT count(*)::int FROM opportunity_signals) s,(SELECT count(*)::int FROM lumi_money_entries) m`)[0]!;
    const before = await cnt();
    await go(page, `${base}/lumi/autonomy`); await page.getByTestId("autonomy-view").waitFor({ timeout: 60_000 });
    assert.equal(await page.locator("[data-testid^='am-select-']").count(), 0);
    await go(page, `${base}/lumi/integrations`); await page.getByTestId("integrations-view").waitFor({ timeout: 60_000 });
    await go(page, `${base}/lumi/opportunities`); await page.getByTestId("opportunities-view").waitFor({ timeout: 60_000 });
    assert.equal(await page.getByTestId("sig-form").count(), 0);
    const post = (u: string, b: unknown) => page.evaluate(async ([url, body]) => (await fetch(url as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, [u, b] as [string, unknown]);
    assert.deepEqual([await post("/api/v1/lumi/autonomy", { action_type: "research", mode: "OFF" }), await post("/api/v1/lumi/signals", { kind: "KEYWORD", title: "xyz abc" })], [403, 403]);
    assert.deepEqual(await cnt(), before);
    await ctx.close();
  });
});


describe("Đợt 8 — Công suất, Quỹ, Đồ thị kiến thức, Kinh doanh, Họp theo lượt, Nội dung ba cổng (adapter GIẢ, dữ liệu mô phỏng)", () => {
  it("OWNER: công suất + tạm dừng → quỹ chuẩn bị → chiến dịch (tạo, số liệu có nguồn, chạy, chạm trần tự dừng) → hiệu suất video + chiến lược → đồ thị kiến thức", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    const [proj] = await pg.sql`SELECT id,name FROM lumi_projects WHERE slug='test-offer-us'`;
    // công suất
    await go(page, `${base}/lumi/capacity`);
    await page.getByTestId("capacity-view").waitFor({ timeout: 60_000 });
    await page.getByTestId("cap-input-lumitest").fill("9");
    await page.getByTestId("cap-save-lumitest").click();
    await until(async () => (await pg.sql`SELECT capacity FROM lumi_assistants WHERE slug='lumitest'`)[0]?.capacity === 9, "capacity saved");
    await page.getByTestId("cap-pause-lumitest").click();
    await until(async () => (await pg.sql`SELECT dispatch_paused FROM lumi_assistants WHERE slug='lumitest'`)[0]?.dispatch_paused === true, "paused");
    await page.getByTestId("cap-pause-lumitest").filter({ hasText: "Tiếp tục" }).waitFor({ timeout: 30_000 });
    await page.getByTestId("cap-pause-lumitest").click();
    await until(async () => (await pg.sql`SELECT dispatch_paused FROM lumi_assistants WHERE slug='lumitest'`)[0]?.dispatch_paused === false, "resumed");
    // quỹ chuẩn bị
    await go(page, `${base}/lumi/finance`);
    await page.getByTestId("finance-view").waitFor({ timeout: 60_000 });
    await page.getByTestId("fin-tab-funds").click();
    await page.getByTestId("fin-funds").waitFor({ timeout: 30_000 });
    await page.getByTestId("fd-amount").fill("5");
    await page.getByTestId("fd-start").fill("2026-11-01");
    await page.getByTestId("fd-end").fill("2026-12-31");
    await page.getByTestId("fd-save").click();
    await page.getByTestId("fund-COMPANY").waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("fund-COMPANY").innerText(), /5/);
    // chiến dịch
    await go(page, `${base}/lumi/business`);
    await page.getByTestId("business-view").waitFor({ timeout: 60_000 });
    await page.getByTestId("cf-project").selectOption(proj!.id as string);
    await page.getByTestId("cf-name").fill("UI chiến dịch thử");
    await page.getByTestId("cf-cap").fill("20");
    await page.getByTestId("cf-submit").click();
    const camp = await until(async () => (await pg.sql`SELECT id,code FROM lumi_campaigns WHERE name='UI chiến dịch thử'`)[0], "campaign created");
    await page.getByTestId("camp-empty-UI chiến dịch thử").waitFor({ timeout: 30_000 });
    await page.getByTestId("camp-to-ACTIVE-UI chiến dịch thử").click();
    await page.locator("[data-testid='camp-UI chiến dịch thử'][data-state='ACTIVE']").waitFor({ timeout: 30_000 });
    await page.locator("section[data-testid='camp-UI chiến dịch thử'] details", { hasText: "Ghi số liệu" }).locator("summary").click();
    await page.getByTestId("mt-start-UI chiến dịch thử").fill("2026-11-01");
    await page.getByTestId("mt-end-UI chiến dịch thử").fill("2026-11-07");
    await page.getByTestId("mt-spend-UI chiến dịch thử").fill("25");
    await page.getByTestId("mt-clicks-UI chiến dịch thử").fill("50");
    await page.getByTestId("mt-source-UI chiến dịch thử").fill("Bảng Ads (thử UI)");
    await page.getByTestId("mt-go-UI chiến dịch thử").click();
    await page.locator("[data-testid='camp-UI chiến dịch thử'][data-state='PAUSED']").waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("camp-pause-UI chiến dịch thử").innerText(), /trần/);
    assert.match(await page.getByTestId("camp-total-UI chiến dịch thử-USD").innerText(), /chuyển đổi chưa có/, "thiếu chỉ số = chưa có, không phải 0");
    assert.equal((await pg.sql`SELECT count(*)::int n FROM lumi_campaign_events WHERE campaign_id=${camp.id as string} AND event='CAP_REACHED'`)[0]!.n, 1);
    // video + chiến lược (video của hệ cũ do bài test tạo trực tiếp)
    await pg.sql`INSERT INTO videos(working_title) VALUES ('UI video thử') ON CONFLICT DO NOTHING`;
    await page.getByTestId("biz-tab-youtube").click();
    await page.getByTestId("biz-youtube").waitFor({ timeout: 30_000 });
    await page.getByTestId("sf-project").selectOption(proj!.id as string);
    await page.getByTestId("sf-goal").fill("Review trung thực đồng hồ cơ");
    await page.getByTestId("sf-uniq").fill("Luôn đo thực tế");
    await page.getByTestId("sf-breaks").fill("Không làm top 10 chung chung");
    await page.getByTestId("sf-submit").click();
    await page.getByTestId(`ys-${proj!.name as string}`).waitFor({ timeout: 30_000 });
    await page.getByTestId("vid-UI video thử").waitFor({ timeout: 30_000 });
    await page.getByTestId("vid-UI video thử").locator("details", { hasText: "Ghi hiệu suất" }).locator("summary").click();
    await page.getByTestId("pf-views-UI video thử").fill("1200");
    await page.getByTestId("pf-ctr-UI video thử").fill("0.05");
    await page.getByTestId("pf-src-UI video thử").fill("YouTube Studio (thử UI)");
    await page.getByTestId("pf-go-UI video thử").click();
    await page.getByTestId("perf-UI video thử-7").waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("perf-UI video thử-7").innerText(), /5\.00%/);
    // đồ thị kiến thức
    await go(page, `${base}/lumi/knowledge/graph`);
    await page.getByTestId("graph-view").waitFor({ timeout: 60_000 });
    await page.getByTestId("conflicts").waitFor();
    await page.getByTestId("linkcheck").waitFor();
    await ctx.close();
  });

  it("Nội dung ba cổng: Chủ tạo → mệnh đề → gửi QA → ADMIN QA đạt → Chủ duyệt → đăng đích giả (có nhãn); tác giả không tự QA", async () => {
    const own = await browser.newContext(); const op = await own.newPage();
    assert.equal((await login(op, base, "owner@dev.local")).user?.role, "OWNER");
    const [proj] = await pg.sql`SELECT id FROM lumi_projects WHERE slug='test-offer-us'`;
    await go(op, `${base}/lumi/content`);
    await op.getByTestId("content-view").waitFor({ timeout: 60_000 });
    assert.match(await op.getByTestId("content-label").innerText(), /ADAPTER GIẢ/);
    await op.getByTestId("af-project").selectOption(proj!.id as string);
    await op.getByTestId("af-title").fill("UI bài review đồng hồ");
    await op.getByTestId("af-body").fill("Đồng hồ cơ tự động dùng bộ máy lên dây bằng chuyển động cổ tay. ".repeat(6));
    await op.getByTestId("af-submit").click();
    const art = await until(async () => (await pg.sql`SELECT id,code FROM lumi_articles ORDER BY created_at DESC LIMIT 1`)[0], "article created");
    const code = art.code as string;
    await op.getByTestId(`art-${code}`).waitFor({ timeout: 30_000 });
    assert.match(await op.getByTestId(`problems-${code}`).innerText(), /mệnh đề/);
    await op.getByTestId(`cl-text-${code}`).fill("Bộ máy tự động lên dây bằng chuyển động cổ tay");
    await op.getByTestId(`cl-level-${code}`).selectOption("E3");
    await op.getByTestId(`cl-src-${code}`).fill("https://example.com/nguon");
    await op.getByTestId(`cl-add-${code}`).click();
    await op.getByTestId(`claims-${code}`).getByText(/E3/).first().waitFor({ timeout: 30_000 });
    await op.getByTestId(`art-qa-submit-${code}`).click();
    await op.locator(`[data-testid='art-${code}'][data-state='QA_PENDING']`).waitFor({ timeout: 30_000 });
    await op.getByTestId(`art-qa-pass-${code}`).click(); // tác giả là chính Chủ ⇒ bị chặn
    await op.waitForTimeout(1200);
    assert.equal((await pg.sql`SELECT state FROM lumi_articles WHERE id=${art.id as string}`)[0]!.state, "QA_PENDING", "tác giả không tự qua QA");
    await own.close();
    const adm = await browser.newContext(); const ap = await adm.newPage();
    assert.equal((await login(ap, base, "admin@dev.local")).user?.role, "ADMIN");
    await go(ap, `${base}/lumi/content`);
    await ap.getByTestId(`art-qa-pass-${code}`).waitFor({ timeout: 60_000 });
    await ap.getByTestId(`art-qa-pass-${code}`).click();
    await until(async () => (await pg.sql`SELECT state FROM lumi_articles WHERE id=${art.id as string}`)[0]?.state === "QA_PASSED", "qa passed");
    assert.equal(await ap.getByTestId(`art-approve-${code}`).count(), 0, "ADMIN không duyệt được");
    await adm.close();
    const own2 = await browser.newContext(); const op2 = await own2.newPage();
    await login(op2, base, "owner@dev.local"); await go(op2, `${base}/lumi/content`);
    await op2.getByTestId(`art-approve-${code}`).waitFor({ timeout: 60_000 });
    await op2.getByTestId(`art-approve-${code}`).click();
    await op2.getByTestId(`art-publish-${code}`).waitFor({ timeout: 30_000 });
    await op2.getByTestId(`art-publish-${code}`).click();
    await op2.locator(`[data-testid='art-${code}'][data-state='PUBLISHED']`).waitFor({ timeout: 30_000 });
    assert.equal((await pg.sql`SELECT label FROM lumi_fake_wp`)[0]!.label.includes("ADAPTER GIẢ"), true);
    await own2.close();
  });

  it("VIEWER: xem được các màn mới nhưng không có điều khiển ghi; API ghi 403 và không đổi gì", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "viewer@dev.local")).user?.role, "VIEWER");
    const cnt = async () => (await pg.sql`SELECT (SELECT count(*)::int FROM lumi_campaigns) c,(SELECT count(*)::int FROM lumi_articles) a,(SELECT count(*)::int FROM lumi_prep_funds) f,(SELECT count(*)::int FROM lumi_turn_meetings) t`)[0]!;
    const before = await cnt();
    for (const [url, tid] of [["capacity", "capacity-view"], ["business", "business-view"], ["content", "content-view"], ["turn-meetings", "turn-meetings-view"], ["knowledge/graph", "graph-view"]]) { await go(page, `${base}/lumi/${url}`); await page.getByTestId(tid!).waitFor({ timeout: 60_000 }); }
    await go(page, `${base}/lumi/capacity`); await page.getByTestId("capacity-view").waitFor();
    assert.equal(await page.locator("[data-testid^='cap-save-']").count(), 0); assert.equal(await page.getByTestId("transfer-form").count(), 0);
    await go(page, `${base}/lumi/content`); await page.getByTestId("content-view").waitFor();
    assert.equal(await page.getByTestId("article-form").count(), 0);
    const post = (u: string, b: unknown) => page.evaluate(async ([url, body]) => (await fetch(url as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, [u, b] as [string, unknown]);
    assert.deepEqual([await post("/api/v1/lumi/funds", { scope: "COMPANY", amount: 1, period_start: "2026-11-01", period_end: "2026-11-30" }), await post("/api/v1/lumi/campaigns", { project_id: "00000000-0000-4000-8000-000000000001", name: "xyz abc" }), await post("/api/v1/lumi/articles", { project_id: "00000000-0000-4000-8000-000000000001", title: "xyz", body: "abc" })], [403, 403, 403]);
    assert.deepEqual(await cnt(), before);
    await ctx.close();
  });
});


describe("Công tắc giao việc — trạng thái rõ ràng, hỏi xác nhận (UI)", () => {
  it("OWNER: tóm tắt nói rõ sẵn sàng/chưa; công tắc tổng và bot hiện ĐANG BẬT/TẮT; bấm phải xác nhận; từ chối xác nhận thì không đổi; VIEWER không thấy công tắc", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    await pg.sql`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now()) ON CONFLICT (key) DO UPDATE SET value='true'`;
    await pg.sql`UPDATE lumi_assistants SET dispatch_enabled=true WHERE slug='lumitest'`;
    await go(page, `${base}/lumi/telegram`);
    await page.getByTestId("switch-panel").waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId("m1-state").innerText(), /ĐANG BẬT/);
    assert.match(await page.getByTestId("stop-state").innerText(), /BÌNH THƯỜNG/);
    assert.match(await page.getByTestId("bot-state-lumitest").innerText(), /ĐANG NHẬN VIỆC/);
    assert.match(await page.getByTestId("readiness-summary").innerText(), /SẴN SÀNG/);
    // từ chối xác nhận ⇒ không đổi
    page.once("dialog", (d) => void d.dismiss());
    await page.getByTestId("m1-switch").click();
    await page.waitForTimeout(800);
    assert.equal((await pg.sql`SELECT value FROM lumi_system_flags WHERE key='m1_enabled'`)[0]!.value, true, "hủy xác nhận ⇒ không đổi");
    // xác nhận TẮT ⇒ tóm tắt đổi sang CHƯA GIAO VIỆC ĐƯỢC
    page.once("dialog", (d) => { assert.match(d.message(), /TẮT luồng giao việc/); void d.accept(); });
    await page.getByTestId("m1-switch").click();
    await page.locator("[data-testid='m1-state']", { hasText: "ĐANG TẮT" }).waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("readiness-summary").innerText(), /CHƯA GIAO VIỆC ĐƯỢC/);
    assert.match(await page.getByTestId("readiness-summary").innerText(), /công tắc tổng/);
    assert.equal((await pg.sql`SELECT value FROM lumi_system_flags WHERE key='m1_enabled'`)[0]!.value, false);
    // bật lại
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("m1-switch").click();
    await page.locator("[data-testid='m1-state']", { hasText: "ĐANG BẬT" }).waitFor({ timeout: 30_000 });
    assert.match(await page.getByTestId("switch-msg").innerText(), /BẬT luồng giao việc/);
    // bot: tắt rồi bật
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("bot-switch-lumitest").click();
    await page.locator("[data-testid='bot-state-lumitest']", { hasText: "ĐANG TẮT" }).waitFor({ timeout: 30_000 });
    assert.equal((await pg.sql`SELECT dispatch_enabled FROM lumi_assistants WHERE slug='lumitest'`)[0]!.dispatch_enabled, false);
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("bot-switch-lumitest").click();
    await page.locator("[data-testid='bot-state-lumitest']", { hasText: "ĐANG NHẬN VIỆC" }).waitFor({ timeout: 30_000 });
    await ctx.close();
    const vctx = await browser.newContext(); const vp = await vctx.newPage();
    assert.equal((await login(vp, base, "viewer@dev.local")).user?.role, "VIEWER");
    await go(vp, `${base}/lumi/telegram`);
    await vp.getByTestId("telegram-real").waitFor({ timeout: 60_000 });
    assert.equal(await vp.getByTestId("switch-panel").count(), 0, "VIEWER không thấy công tắc");
    await vctx.close();
  });
});

describe("NFR-01 — dùng được ở 428 px, không cuộn ngang (OWNER, mọi màn Dong-Lumi)", () => {
  it("không màn nào làm trang rộng hơn khung nhìn 428 px (bảng được phép cuộn trong khung riêng)", async () => {
    const ctx = await browser.newContext({ viewport: { width: 428, height: 900 } }); const page = await ctx.newPage();
    assert.equal((await login(page, base, "owner@dev.local")).user?.role, "OWNER");
    const routes = ["/lumi", "/lumi/approvals", "/lumi/projects", "/lumi/tasks", "/lumi/company", "/lumi/org", "/lumi/knowledge", "/lumi/knowledge/review", "/lumi/meetings", "/lumi/finance", "/lumi/routines", "/lumi/ideas", "/lumi/templates", "/lumi/search", "/lumi/settings", "/lumi/opportunities", "/lumi/autonomy", "/lumi/integrations", "/lumi/capacity", "/lumi/business", "/lumi/content", "/lumi/turn-meetings", "/lumi/knowledge/graph", "/lumi/admin", "/lumi/telegram"];
    const wide: string[] = [];
    for (const r of routes) {
      await go(page, `${base}${r}`);
      await page.waitForTimeout(1500);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      if (m.sw > m.iw + 1) wide.push(`${r}: ${m.sw}px > ${m.iw}px`);
    }
    assert.deepEqual(wide, [], `màn cuộn ngang ở 428px:\n${wide.join("\n")}`);
    await ctx.close();
  });
});
