import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { ownerOutboundAlerts } from "@/lib/db/schema/notifications";
import {
  isAssistantProfile,
  renderForDelivery,
  serviceTokenMatches,
} from "@/lib/notify/outbound-policy";

/**
 * P4-R09 AC-05 — the collector's endpoint.
 *
 * `GET /api/v1/outbound/alerts?profile=aff`
 *
 * Called by a Hermes cron job running inside the AFF or YT gateway. It returns
 * the pending alerts for that assistant as **plain text**, and marks them
 * dispatched in the same transaction.
 *
 * ## Plain text, not JSON, on purpose
 *
 * The caller is a shell script whose **stdout is delivered verbatim** to
 * Telegram (`no_agent: true`). Returning JSON would put braces in the owner's
 * chat, or require the script to parse — and a script that parses is a script
 * that can parse wrongly at 3am.
 *
 * ## At-most-once, stated rather than glossed
 *
 * Alerts are marked dispatched when they are HANDED OVER, not when Telegram
 * confirms — the script cannot report back, because its stdout *is* the
 * message. So a delivery lost between here and Telegram is not retried.
 *
 * That is the safe direction here: the Ops Hub keeps the row and the failure
 * remains visible in its own surfaces, so a lost Telegram message delays the
 * owner rather than hiding the failure. The alternative — re-sending until
 * confirmed — would repeat the same alert every minute with nothing able to
 * stop it.
 */

export const dynamic = "force-dynamic";

function text(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // The service boundary. Fails closed when unconfigured -- an endpoint that
  // opened because its token was missing would be a public queue of production
  // failures.
  const auth = serviceTokenMatches(
    req.headers.get("x-dc-service-token"),
    process.env.OPS_HUB_SERVICE_TOKEN,
  );
  if (!auth.ok) {
    // One response for every refusal. Distinguishing "not configured" from
    // "wrong token" tells an attacker which half to work on.
    return text("", 401);
  }

  const profile = req.nextUrl.searchParams.get("profile");
  if (!isAssistantProfile(profile)) {
    return text("", 400);
  }

  const collector = `hermes-cron:${profile}`;
  const now = new Date();

  // One statement. Selecting then updating would let two ticks of the same
  // cron -- or the aff and yt collectors racing -- hand the same alert to the
  // owner twice.
  const claimed = await db
    .update(ownerOutboundAlerts)
    .set({ dispatchedAt: now, dispatchedBy: collector })
    .where(
      and(
        eq(ownerOutboundAlerts.profile, profile),
        isNull(ownerOutboundAlerts.dispatchedAt),
        sql`${ownerOutboundAlerts.id} IN (
          SELECT id FROM owner_outbound_alerts
          WHERE profile = ${profile} AND dispatched_at IS NULL
          ORDER BY created_at
          LIMIT 20
          FOR UPDATE SKIP LOCKED
        )`,
      ),
    )
    .returning({ body: ownerOutboundAlerts.body, createdAt: ownerOutboundAlerts.createdAt });

  if (claimed.length === 0) {
    // Empty body, not "no alerts". The cron job delivers stdout verbatim, and
    // Hermes skips whitespace-only content -- so nothing is sent, which is
    // exactly right for a quiet minute.
    return text("");
  }

  const ordered = [...claimed].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return text(renderForDelivery(ordered));
}
