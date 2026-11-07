/**
 * Test helper process (spawned by pg-server.test.ts): claims one outbox row with a 2s lease, marks the run DISPATCHED and then
 * hangs inside Hermes.dispatch() forever — the parent SIGKILLs it to simulate a worker dying mid-dispatch.
 */
import { processOutbox } from "./core";
import { connectLumi, postgresDb } from "./pg-adapter";

const sql = connectLumi(process.env.DATABASE_URL!, { max: 2 });
const db = postgresDb(sql);
const hermes = {
  async readProfileTools() { return []; },
  async dispatch() { console.log("DISPATCHING"); await new Promise(() => {}); return { kind: "accepted" as const }; },
};
processOutbox(db, { hermes, notify: { send: async () => {} } }, "crash-child", new Date(), 2).then(() => process.exit(0));
