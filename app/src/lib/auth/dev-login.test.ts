import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDevLoginEnabled } from "./dev-login";

const L = "http://localhost:3100";
/** Inherit the machine's own environment (HOME/TMPDIR/PATH are needed by tsx on Linux) but remove everything that decides the gate, then apply the case under test. */
function cleanEnv(over: Record<string, string>): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of ["NODE_ENV", "LUMI_DEV_LOGIN", "NEXTAUTH_URL", "LUMI_DATA", "DONGLUMI_PREVIEW", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) delete base[k];
  return { ...base, DATABASE_URL: "postgres://x:y@127.0.0.1:1/z", NEXTAUTH_SECRET: "t".repeat(40), ...over } as unknown as NodeJS.ProcessEnv;
}
describe("dev login gate", () => {
  it("needs a non-production NODE_ENV, LUMI_DEV_LOGIN=1 and a local NEXTAUTH_URL", () => {
    assert.equal(isDevLoginEnabled({ NODE_ENV: "development", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: L }), true);
    assert.equal(isDevLoginEnabled({ NODE_ENV: "development", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: "http://127.0.0.1:3000" }), true);
    assert.equal(isDevLoginEnabled({ NODE_ENV: "development", NEXTAUTH_URL: L }), false);
    assert.equal(isDevLoginEnabled({ NODE_ENV: "production", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: L }), false);
    assert.equal(isDevLoginEnabled({ LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: "https://app.dongchannel.com" }), false);
    assert.equal(isDevLoginEnabled({ NODE_ENV: "development", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: "https://staging.example.com" }), false);
    assert.equal(isDevLoginEnabled({ NODE_ENV: "development", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: "http://localhost.evil.com" }), false);
    assert.equal(isDevLoginEnabled({ NODE_ENV: "development", LUMI_DEV_LOGIN: "1" }), false);
    assert.equal(isDevLoginEnabled({ NODE_ENV: "development", LUMI_DEV_LOGIN: "true", NEXTAUTH_URL: L }), false);
  });

  it("the REAL auth options list the dev-login provider only when the gate is open (separate process per environment)", () => {
    // A probe FILE, not `node -e`: Node 20 (the VPS) rejects the dynamic import in an eval script. Written inside the app dir so "@/" paths resolve.
    const probeFile = path.join(process.cwd(), `.dev-login-probe-${process.pid}.mts`);
    fs.writeFileSync(probeFile, `import("./src/lib/auth/options").then((m) => console.log("PROVIDERS " + m.authOptions.providers.map((p: { id: string }) => p.id).join(","))).catch((e) => console.log("ERR " + String(e).slice(0, 300)));`);
    const run = (env: Record<string, string>) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "--conditions=react-server", probeFile], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
        env: cleanEnv(env),
      });
      return (r.stdout.split(String.fromCharCode(10)).find((l) => l.startsWith("PROVIDERS ")) ?? `NONE ${r.stderr.slice(0, 200)}`).slice(10);
    };
    assert.match(run({ NODE_ENV: "development", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: L }), /credentials/);
    assert.doesNotMatch(run({ NODE_ENV: "development", NEXTAUTH_URL: L }), /credentials/);
    assert.doesNotMatch(run({ NODE_ENV: "production", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: L }), /credentials/);
    assert.doesNotMatch(run({ NODE_ENV: "development", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: "https://staging.example.com" }), /credentials/);
    assert.match(run({ NODE_ENV: "production", NEXTAUTH_URL: "https://x.example.com" }), /google/);
    fs.rmSync(probeFile, { force: true });
  });
});
