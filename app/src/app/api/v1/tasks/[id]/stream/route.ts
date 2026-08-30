import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema/tasks";
import { requireRoleForApi } from "@/lib/authz";

/**
 * P4-R12 AC-06 — GET /api/v1/tasks/:id/stream
 *
 * A REAL event source, not a UI that looks live.
 *
 * ## Why this streams from OUR database and not from Hermes
 *
 * `src/lib/hermes/sse.ts` is a stub that throws, and its own comment says it
 * waits on a Discovery Gate confirming Hermes's SSE endpoint. That gate has not
 * been passed, and building on an endpoint nobody has confirmed would be
 * guessing at a contract.
 *
 * The task's status in Postgres is a real source of truth in its own right --
 * it is what the Ops Hub renders and what the retry path changes. Streaming it
 * is not a stand-in for the Hermes stream; it is the thing the surface actually
 * needs to know.
 *
 * ## Honest about what it is
 *
 * Every event carries `transport: "STREAM"` and an `asOf`. The connection
 * detects change by comparing against the last value sent, so an idle stream
 * sends heartbeats rather than repeating a stale status as though it were new.
 * `AC-06` forbids exactly one thing -- a surface that appears live and is not --
 * and a heartbeat is how a reader can tell the difference.
 */

export const dynamic = "force-dynamic";

/** How often the source is re-read. Not a poll the CLIENT does. */
const TICK_MS = 2000;
/** Sent when nothing changed, so silence never reads as "still connected". */
const HEARTBEAT_MS = 15000;
/** Connections do not live forever; the client reconnects. */
const MAX_MS = 5 * 60 * 1000;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN"], requestId);
  if ("error" in gate) return gate.error;

  const { id } = await ctx.params;

  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      let lastStatus: string | null = null;
      let lastSent = 0;
      let closed = false;

      const send = (event: string, payload: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
        );
        lastSent = Date.now();
      };

      const tick = async () => {
        if (closed) return;
        if (Date.now() - started > MAX_MS) {
          send("end", { reason: "MAX_DURATION" });
          closed = true;
          controller.close();
          return;
        }

        const [row] = await db
          .select({ status: tasks.status, updatedAt: tasks.updatedAt })
          .from(tasks)
          .where(eq(tasks.id, id))
          .limit(1);

        if (!row) {
          send("end", { reason: "TASK_NOT_FOUND" });
          closed = true;
          controller.close();
          return;
        }

        if (row.status !== lastStatus) {
          lastStatus = row.status;
          send("status", {
            taskId: id,
            status: row.status,
            transport: "STREAM",
            asOf: new Date().toISOString(),
          });
        } else if (Date.now() - lastSent > HEARTBEAT_MS) {
          // Not a status repeat. A heartbeat says "the connection is alive and
          // nothing changed", which is different information from "here is the
          // status again" -- and only one of them is true.
          send("heartbeat", { asOf: new Date().toISOString() });
        }

        setTimeout(() => void tick(), TICK_MS);
      };

      await tick();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
