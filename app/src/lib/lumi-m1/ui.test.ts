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

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
let pg: PgServer;
let browser: Browser;
const kids: ChildProcess[] = [];
let base = "";
let baseNoLogin = "";

const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const nextBin = () => path.join(path.dirname(require.resolve("next/package.json")), "dist", "bin", "next");

async function waitHttp(url: string, ms = 120_000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
function startNext(port: number, extra: Record<string, string>): ChildProcess {
  const c = spawn(process.execPath, [nextBin(), "dev", "-p", String(port)], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: pg.url, NEXTAUTH_URL: `http://localhost:${port}`, NEXTAUTH_SECRET: "ui-test-only-secret-0123456789abcdef0123", NODE_ENV: "development", ...extra },
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
    await page.getByTestId("new-task").click();
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
