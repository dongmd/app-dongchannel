/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface (typed at the boundary in TDD 14.9) */
/**
 * Test-only: a real PostgreSQL engine (PGlite, WASM) with the REAL migrations 0000..latest replayed.
 * Limits (stated in TDD 14.9): single connection, so "concurrency" tests interleave operations deterministically;
 * they prove SQL constraints/idempotency/lease logic but not multi-process timing.
 */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./core";

function wrap(pg: any, inTx: boolean): Db {
  return {
    query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params as any[])).rows as any[],
    tx: <T>(fn: (db: Db) => Promise<T>): Promise<T> => (inTx ? fn(wrap(pg, true)) : pg.transaction((tx: any) => fn(wrap(tx, true)))),
  };
}

export async function freshDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite();
  const dir = path.resolve(process.cwd(), "src/lib/db/migrations");
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    for (const st of fs.readFileSync(path.join(dir, f), "utf8").split("--> statement-breakpoint")) {
      if (st.trim()) await pg.exec(st);
    }
  }
  return { db: wrap(pg, false), pg };
}
