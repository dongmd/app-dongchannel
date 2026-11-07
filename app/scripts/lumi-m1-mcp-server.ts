/**
 * Dedicated MCP endpoint for the Hermes test profile (NOT the Next app): `POST http://127.0.0.1:<port>/mcp`.
 * Why separate: the SSH tunnel to the VPS forwards ONLY this port, so the web app, its login pages (incl. the dev login) and the
 * database are never reachable from the VPS. It binds to 127.0.0.1 only.
 * Auth: `Authorization: Bearer <token>` (or `x-dc-service-token`), compared in constant time against LUMI_BOT_TOKENS (slug:token,…).
 * The token is read from the environment and is never logged.
 *   DATABASE_URL=… LUMI_BOT_TOKENS=lumitest:… pnpm tsx scripts/lumi-m1-mcp-server.ts [--port 3199]
 */
import http from "node:http";
import { connectLumi, postgresDb } from "../src/lib/lumi-m1/pg-adapter";
import { resolveBotToken } from "../src/lib/lumi-m1/handlers";
import { handleRpc, intakeFromChat } from "../src/lib/lumi-m1/mcp";
import { SimulatedHermes } from "../src/lib/lumi-m1/hermes-port";

const url = process.env.DATABASE_URL;
const tokens = process.env.LUMI_BOT_TOKENS;
if (!url || !tokens) { console.error("DATABASE_URL and LUMI_BOT_TOKENS are required"); process.exit(1); }
const portArgIdx = process.argv.indexOf("--port");
const port = Number((portArgIdx >= 0 ? process.argv[portArgIdx + 1] : undefined) || process.env.LUMI_MCP_PORT || 3199); // (a missing --port used to read argv[0] => NaN)
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error(`invalid MCP port: ${port}`); process.exit(2); }
const db = postgresDb(connectLumi(url, { max: 3 }));
const ctx = { db, hermes: new SimulatedHermes(), now: () => new Date() }; // hermes port unused by MCP tools

// LUMI_MCP_ACTORS="slug=telegram:<id>,slug2=…": the person behind each bot (server-side; the model cannot choose it).
const actors = new Map((process.env.LUMI_MCP_ACTORS ?? "").split(",").map((x) => x.trim().split("=")).filter((x) => x.length === 2 && x[0] && x[1]) as [string, string][]);
const opts = { actorFor: (slug: string) => actors.get(slug) };
const MAX = 64 * 1024;
const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  try {
    const route = req.url?.split("?")[0];
    if (route !== "/mcp" && route !== "/intake") return send(res, 404);
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? (req.headers["x-dc-service-token"] as string | undefined);
    const slug = resolveBotToken(bearer, tokens);
    if (!slug) return send(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }, { "www-authenticate": "Bearer" });
    if (req.method === "DELETE") return send(res, 200);
    if (req.method !== "POST") return send(res, 405, undefined, { allow: "POST" }); // no server-initiated SSE stream
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > MAX) return send(res, 413); chunks.push(c as Buffer); }
    if (route === "/intake") {
      // Gateway hook -> deterministic draft intake. Body: {user_id, text}. Same bot token auth as /mcp.
      let b: any; try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { ok: false, reply: "JSON không hợp lệ" }); }
      const r = await intakeFromChat(ctx, { kind: "bot", slug, actorRef: `bot:${slug}` }, String(b?.user_id ?? ""), String(b?.text ?? ""));
      return send(res, r.ok ? 200 : 422, r);
    }
    let msg: any; try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    const principal = { kind: "bot" as const, slug, actorRef: `bot:${slug}` };
    const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => handleRpc(ctx, principal, m, opts)))).filter((x) => x !== null) : await handleRpc(ctx, principal, msg, opts);
    if (out === null || (Array.isArray(out) && out.length === 0)) return send(res, 202);
    send(res, 200, out);
  } catch { send(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } }); }
}).listen(port, "127.0.0.1", () => console.log(`[mcp] listening on 127.0.0.1:${port} (loopback only); MCP tools: knowledge_context, outputs_submit; POST /intake for the gateway hook`));
