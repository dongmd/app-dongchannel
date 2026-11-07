// Môi trường THỬ cục bộ cho Dong-Lumi M1: `pnpm lumi:m1:dev`
//  - PostgreSQL thật (embedded-postgres) trong thư mục .lumi-dev/ (xoá thư mục = xoá sạch dữ liệu thử)
//  - chạy toàn bộ migration thật, nạp dữ liệu mẫu (KHÔNG phải dữ liệu thật của Chủ)
//  - Next dev server ở http://localhost:3100/work, đăng nhập thử (chỉ máy dev: NODE_ENV!=production + LUMI_DEV_LOGIN=1)
//  - worker M1 chế độ MÔ PHỎNG (Hermes/Telegram giả, có nhãn)
// Không đụng VPS, Telegram, Hermes hay bí mật nào.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = process.cwd();
const dataDir = path.join(root, ".lumi-dev", "pgdata");
const PG_PORT = Number(process.env.LUMI_DEV_PG_PORT ?? 54329);
const WEB_PORT = Number(process.env.PORT ?? 3100);
const url = `postgres://lumi:lumi-dev@127.0.0.1:${PG_PORT}/lumi_dev`;
const children = [];
const REAL = process.argv.includes("--real"); // real Hermes test profile over SSH + MCP endpoint (otherwise simulated)
const stop = async (pg) => { for (const c of children) c.kill(); try { await pg?.stop(); } catch {} process.exit(0); };

const { default: EmbeddedPostgres } = await import("embedded-postgres");
const fresh = !fs.existsSync(path.join(dataDir, "PG_VERSION"));
fs.mkdirSync(dataDir, { recursive: true });
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "lumi", password: "lumi-dev", port: PG_PORT, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("lumi_dev");
process.on("SIGINT", () => stop(pg));
process.on("SIGTERM", () => stop(pg));

// Migrate + seed through the TypeScript helper (same code the tests use).
const tsx = ["--import", "tsx", "--conditions=react-server"];
await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [...tsx, "scripts/lumi-m1-seed.ts"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("seed failed"))));
});

const env = {
  ...process.env,
  DATABASE_URL: url,
  NEXTAUTH_URL: `http://localhost:${WEB_PORT}`,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? "local-dev-only-not-a-secret-0123456789abcdef",
  LUMI_DEV_LOGIN: "1",
  LUMI_DATA: "db", // giao diện Dong-Lumi (/lumi) đọc/ghi PostgreSQL thật, bắt buộc đăng nhập
  ...(process.argv.includes("--real") ? { LUMI_TELEGRAM_BOT: process.env.LUMI_TELEGRAM_BOT ?? "lumi_test_dong_bot" } : {}),
  NODE_ENV: "development",
  LUMI_BOT_TOKENS: process.env.LUMI_BOT_TOKENS ?? "lumitest:dev-only-bot-token-not-secret",
  ...(REAL ? { LUMI_HERMES_MODE: "ssh" } : {}),
};
if (REAL) {
  // The MCP/service token lives in the gitignored private/key-token.md (never printed). Env var LUMI_BOT_TOKENS overrides it.
  if (!process.env.LUMI_BOT_TOKENS) {
    const f = path.join(root, "..", "..", "private", "key-token.md");
    const line = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(String.fromCharCode(10)).map((l) => l.trim()).find((l) => l.startsWith("MCP token lumitest")) : null;
    if (!line) { console.error("--real needs LUMI_BOT_TOKENS or private/key-token.md with an `MCP token lumitest: …` line"); await stop(pg); }
    env.LUMI_BOT_TOKENS = `lumitest:${line.split(": ")[1].trim()}`;
    const idLine = fs.readFileSync(f, "utf8").split(String.fromCharCode(10)).map((l) => l.trim()).find((l) => l.startsWith("ID telegram"));
    if (idLine && !process.env.LUMI_MCP_ACTORS) env.LUMI_MCP_ACTORS = `lumitest=telegram:${idLine.split(": ")[1].trim()}`;
  }
}
const nextBin = join(dirname(require.resolve("next/package.json")), "dist", "bin", "next");
children.push(spawn(process.execPath, [nextBin, "dev", "-p", String(WEB_PORT)], { stdio: "inherit", env }));
children.push(spawn(process.execPath, [...tsx, "scripts/lumi-m1-worker.ts", REAL ? "--hermes-ssh" : "--simulate"], { stdio: "inherit", env }));
if (REAL) children.push(spawn(process.execPath, [...tsx, "scripts/lumi-m1-mcp-server.ts", "--port", "3199"], { stdio: "inherit", env }));
console.log(`\nDong-Lumi M1 (môi trường thử): http://localhost:${WEB_PORT}/lumi\nĐăng nhập thử: gọi POST /api/auth/callback/dev-login (xem docs/TDD 14.9) hoặc dùng nút trên /login nếu có.\nOWNER: owner@dev.local · ADMIN: admin@dev.local · VIEWER: viewer@dev.local\nNhấn Ctrl+C để dừng (dữ liệu giữ trong .lumi-dev/).`);
await new Promise(() => {});
