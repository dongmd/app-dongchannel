/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Production adapter: `Db` (core.ts) over postgres.js. Each `query` is one statement; `tx` is a real transaction on
 * ONE pooled connection (`sql.begin`), so SELECT … FOR UPDATE / SKIP LOCKED behave as in PostgreSQL proper.
 * Dates are returned as JS Date, bigint counts are cast to text in SQL by the core.
 */
import type postgres from "postgres";
import type { Db } from "./core";

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

function wrap(sql: Sql, inTx: boolean): Db {
  return {
    query: async (text: string, params?: unknown[]) => (await (sql as any).unsafe(text, (params ?? []) as any[])) as any[],
    tx: <T>(fn: (db: Db) => Promise<T>): Promise<T> =>
      inTx ? fn(wrap(sql, true)) : ((sql as postgres.Sql<any>).begin(async (t) => fn(wrap(t, true))) as Promise<T>),
  };
}

export function postgresDb(sql: postgres.Sql<any>): Db {
  return wrap(sql, false);
}

/**
 * postgres.js JSON-encodes every jsonb parameter again, so a string that the core already JSON.stringify'd would be stored as a
 * JSON *string* ('"{…}"') instead of an object. Found by the real-server tests (PGlite does not do this). This client passes
 * strings through untouched and still serialises objects. ALL M1 code must create its connection with this factory.
 */
import postgresJs from "postgres";
export function connectLumi(url: string, opts: { max?: number } = {}): postgres.Sql<any> {
  const ser = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x));
  const parse = (x: string) => JSON.parse(x);
  return postgresJs(url, {
    max: opts.max ?? 5, idle_timeout: 30, connect_timeout: 10, prepare: false, onnotice: () => {},
    types: { json: { to: 114, from: [114, 3802], serialize: ser, parse }, jsonb: { to: 3802, from: [3802], serialize: ser, parse } } as any,
  });
}
