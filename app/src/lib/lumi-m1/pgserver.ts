/**
 * Test-only: a REAL PostgreSQL server process (embedded-postgres binaries, separate OS processes/connections),
 * with the real migrations replayed. This is the "PostgreSQL server" evidence class of TDD 14.9 —
 * different from PGlite (single-connection WASM). Data lives in a temp dir and is deleted on stop.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type postgres from "postgres";
import { connectLumi } from "./pg-adapter";
import EmbeddedPostgres from "embedded-postgres";

export interface PgServer {
  url: string;
  sql: ReturnType<typeof postgres>;
  version: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

export async function replayMigrations(sql: ReturnType<typeof postgres>, upTo?: string, from?: string): Promise<void> {
  const dir = path.resolve(process.cwd(), "src/lib/db/migrations");
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    if (upTo && f.slice(0, 4) > upTo) break;
    if (from && f.slice(0, 4) < from) continue;
    for (const st of fs.readFileSync(path.join(dir, f), "utf8").split("--> statement-breakpoint")) {
      if (st.trim()) await sql.unsafe(st);
    }
  }
}

export async function startPgServer(opts: { migrate?: boolean } = {}): Promise<PgServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "lumi", password: "lumi-test", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("lumi_test");
  const url = `postgres://lumi:lumi-test@127.0.0.1:${port}/lumi_test`;
  const sql = connectLumi(url, { max: 10 });
  if (opts.migrate !== false) await replayMigrations(sql);
  const [v] = await sql`SHOW server_version`;
  return {
    url,
    sql,
    version: String(v!.server_version),
    async stop() {
      await sql.end({ timeout: 2 });
      await pg.stop();
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may hold the dir briefly; temp dir, harmless */ }
    },
  };
}
