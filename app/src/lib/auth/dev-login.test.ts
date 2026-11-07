import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isDevLoginEnabled } from "./dev-login";

const L = "http://localhost:3100";
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
    const probe = "import('./src/lib/auth/options').then((m)=>console.log('PROVIDERS '+m.authOptions.providers.map((p)=>p.id).join(',')))";
    const run = (env: Record<string, string>) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "-e", probe], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", DATABASE_URL: "postgres://x:y@127.0.0.1:1/z", NEXTAUTH_SECRET: "t".repeat(40), ...env } as unknown as NodeJS.ProcessEnv,
      });
      return (r.stdout.split(String.fromCharCode(10)).find((l) => l.startsWith("PROVIDERS ")) ?? `NONE ${r.stderr.slice(0, 200)}`).slice(10);
    };
    assert.match(run({ NODE_ENV: "development", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: L }), /credentials/);
    assert.doesNotMatch(run({ NODE_ENV: "development", NEXTAUTH_URL: L }), /credentials/);
    assert.doesNotMatch(run({ NODE_ENV: "production", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: L }), /credentials/);
    assert.doesNotMatch(run({ NODE_ENV: "development", LUMI_DEV_LOGIN: "1", NEXTAUTH_URL: "https://staging.example.com" }), /credentials/);
    assert.match(run({ NODE_ENV: "production", NEXTAUTH_URL: "https://x.example.com" }), /google/);
  });
});
