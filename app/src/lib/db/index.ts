import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as unknown as {
  __pg: ReturnType<typeof postgres> | undefined;
};

const client =
  globalForDb.__pg ??
  postgres(process.env.DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__pg = client;
}

export const db = drizzle(client, { schema, logger: process.env.NODE_ENV !== "production" });
export type Database = typeof db;
