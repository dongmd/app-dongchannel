// Chạy bản preview Dong-Lumi trên máy local (Windows/macOS/Linux): `pnpm preview`
// - dữ liệu mô phỏng lưu trong .preview-data/ (không cần Postgres, không bí mật, không gọi Hermes/Telegram/model)
// - tự build nếu chưa có bản build; mở http://127.0.0.1:3010/lumi
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const port = process.env.PORT ?? "3010";
const env = {
  ...process.env,
  DONGLUMI_PREVIEW: "1",
  NEXTAUTH_URL: `http://localhost:${port}`,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? "local-preview-only-not-a-secret-0123456789",
  NODE_ENV: "production",
};
const require = createRequire(import.meta.url);
const nextBin = join(dirname(require.resolve("next/package.json")), "dist", "bin", "next");

if (process.argv.includes("--build") || !existsSync(join(".next", "BUILD_ID"))) {
  console.log("Đang build lần đầu…");
  const b = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit", env });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
console.log(`Preview Dong-Lumi: http://127.0.0.1:${port}/lumi  (dữ liệu mô phỏng)`);
const child = spawn(process.execPath, [nextBin, "start", "-p", port, "-H", "127.0.0.1"], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
