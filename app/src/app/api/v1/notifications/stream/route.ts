import { type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import postgres from "postgres";
import { authOptions } from "@/lib/auth/options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// SSE stream — không cần buffer.

// AC06/AC08 — Postgres LISTEN dedicated connection cho mỗi client.
// Client mount subscribe, unmount unsubscribe. Payload nhỏ (id + type) → client
// gọi lại /api/v1/notifications để refetch full list.
export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return new Response("Cần đăng nhập", { status: 401 });
  }
  const userId = session.user.id;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return new Response("DATABASE_URL missing", { status: 500 });

  const channel = `notifications:${userId}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream closed
        }
      };

      // Comment initial ping — giữ connection alive
      write(`: connected ${new Date().toISOString()}\n\n`);

      // Dedicated postgres connection cho LISTEN (không share pool)
      const sql = postgres(dbUrl, { max: 1, prepare: false });
      let closed = false;

      const cleanup = async () => {
        if (closed) return;
        closed = true;
        try {
          await sql`UNLISTEN ${sql(channel)}`;
        } catch {
          // ignore
        }
        try {
          await sql.end({ timeout: 1 });
        } catch {
          // ignore
        }
      };

      // Heartbeat 30s — ngăn timeout ở reverse proxy
      const heartbeat = setInterval(() => {
        if (closed) return;
        write(`: heartbeat ${Date.now()}\n\n`);
      }, 30_000);

      try {
        await sql.listen(channel, (payload: string) => {
          if (closed) return;
          write(`event: notification\ndata: ${payload}\n\n`);
        });
      } catch (err) {
        write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
        clearInterval(heartbeat);
        await cleanup();
        controller.close();
        return;
      }

      // Detect client disconnect
      const abortHandler = async () => {
        clearInterval(heartbeat);
        await cleanup();
        try {
          controller.close();
        } catch {
          // ignore
        }
      };
      // AbortSignal của request được exposed qua controller.signal? Không —
      // Next.js chưa expose. Dùng interval poll để kiểm tra desired size.
      const checkClosed = setInterval(() => {
        if (controller.desiredSize === null) {
          clearInterval(checkClosed);
          void abortHandler();
        }
      }, 5000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
