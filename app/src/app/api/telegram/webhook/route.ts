import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { recordAudit, type AuditTx } from "@/lib/audit/write";
import {
  narrowUpdate,
  transportAuditRecordFor,
  verifyTransport,
  type TelegramUpdateBody,
} from "@/lib/telegram/transport-policy";
import { authorize } from "@/lib/telegram/gateway-policy";
import { auditRecordFor } from "@/lib/telegram/gateway-policy";
import { runCommand, type HandlerContext } from "@/lib/telegram/command-handlers";
import { COMMANDS } from "@/lib/telegram/gateway-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * P3-R01 AC-07 — the Telegram webhook.
 *
 * ## Deployed shut
 *
 * With `TELEGRAM_WEBHOOK_SECRET` unset — its state on production — every request
 * is refused by `verifyTransport` before anything is read. That is the
 * activation gate expressed as behaviour rather than as a deployment decision:
 * this file can ship, be reachable, and still do nothing until a secret is
 * deliberately installed.
 *
 * ## The order is the security
 *
 * verify transport → audit → narrow → authorise → audit → dispatch. Nothing
 * before the first step touches the body, and nothing after a refusal proceeds.
 * Each layer refuses on its own terms and records its own decision, so a
 * forged request, a stranger, and an unknown command are three distinguishable
 * events rather than one shrug.
 *
 * ## Why it always answers 200
 *
 * Telegram retries a webhook that returns an error, so a 4xx on a forged
 * request would turn a refusal into a retry loop against ourselves, and a 401
 * would tell an attacker their guess was wrong in a way a 200 does not. The
 * refusal is recorded in the audit log, which is where refusals belong; the
 * response body carries no detail at all.
 */

const ALLOWLIST: readonly number[] = (process.env.TELEGRAM_OWNER_IDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isSafeInteger(n) && n > 0);

/**
 * `recordAudit` takes a deliberately minimal structural type so that
 * `lib/audit/write.ts` imports no Drizzle types and stays provable offline —
 * that is `P3-R06`'s design, and it is not changed to accommodate this caller.
 * The cast is where the real transaction handle meets that narrow contract, and
 * it lives here rather than there.
 */
function asAuditTx(tx: unknown): AuditTx {
  return tx as AuditTx;
}

/** One shape for every answer. Telegram is told nothing it did not already know. */
function ack() {
  return NextResponse.json({ data: { ok: true }, meta: {}, error: null }, { status: 200 });
}

export async function POST(req: Request) {
  const now = new Date();

  const decision = verifyTransport(
    {
      method: "POST",
      secretHeader: req.headers.get("x-telegram-bot-api-secret-token") ?? undefined,
      contentLength: Number(req.headers.get("content-length") ?? 0),
    },
    process.env.TELEGRAM_WEBHOOK_SECRET,
  );

  const tRec = transportAuditRecordFor(decision);
  await db.transaction((tx) =>
    recordAudit(asAuditTx(tx), { actorType: tRec.actorType, action: tRec.action, result: tRec.result }, now),
  );

  if (decision.outcome !== "ACCEPT") return ack();

  // Only now is the body read. Everything above ran on headers alone.
  let body: TelegramUpdateBody;
  try {
    body = (await req.json()) as TelegramUpdateBody;
  } catch {
    await db.transaction((tx) =>
      recordAudit(asAuditTx(tx), { actorType: "system", action: "telegram.transport.refuse", result: "REFUSED" }, now),
    );
    return ack();
  }

  const update = narrowUpdate(body);
  if (!update) {
    await db.transaction((tx) =>
      recordAudit(asAuditTx(tx), { actorType: "system", action: "telegram.transport.refuse", result: "REFUSED" }, now),
    );
    return ack();
  }

  // A verified request is still an unauthorised one until the gateway says
  // otherwise. Transport answers "did Telegram send this"; this answers "may
  // this caller act", and the two are recorded separately on purpose.
  const gw = authorize(update, ALLOWLIST, now);
  const gRec = auditRecordFor(gw, now);
  await db.transaction((tx) => recordAudit(asAuditTx(tx), gRec, now));

  if (gw.outcome !== "ALLOW") return ack();

  // Callbacks resolve through P3-R03 against a stored action record, which this
  // route does not hold. Until that lookup is wired, a callback is acknowledged
  // and not acted on -- the safe half of the pair.
  if (update.kind === "callback") return ack();

  const ctx: HandlerContext = { db, permitted: [...COMMANDS] };
  await runCommand(ctx, gw);

  return ack();
}
