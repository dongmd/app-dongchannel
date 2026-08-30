import { NextResponse, type NextRequest } from "next/server";

import { requireRoleForApi } from "@/lib/authz";
import { retryTask } from "@/lib/tasks/retry";
import type { RetryOutcome } from "@/lib/tasks/retry";

/**
 * P4-R12 — POST /api/v1/tasks/:id/retry
 *
 * The endpoint DC-015 promised and that never existed. `review-actions.tsx`
 * told users retry was coming; nothing was tracking it.
 *
 * Re-execution is injected as a no-op for now, and that is honest rather than
 * unfinished: the task re-enters the QUEUED state and the existing Hermes
 * ingestion picks it up. This requirement governs RE-ENTRY into a substrate
 * that already exists -- it does not become the runtime.
 */

const STATUS: Record<string, number> = {
  NOT_AUTHENTICATED: 401,
  ROLE_NOT_PERMITTED: 403,
  PROFILE_NOT_PERMITTED: 403,
  TASK_NOT_FOUND: 404,
  TASK_STILL_RUNNING: 409,
  TASK_ALREADY_SUCCEEDED: 409,
  TASK_WAS_CANCELLED: 409,
  TASK_AWAITING_REVIEW: 409,
  TASK_NOT_IN_A_FAILURE_STATE: 409,
  RETRY_BUDGET_EXHAUSTED: 429,
};

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN"], requestId);
  if ("error" in gate) return gate.error;

  const { id } = await ctx.params;

  const outcome: RetryOutcome = await retryTask(
    {
      requester: {
        userId: gate.session.user?.id ?? gate.session.user?.email ?? null,
        role: gate.session.user.role,
        // `null`, not `[]`, and the difference matters. This codebase has NO
        // per-user profile allowlist -- `session.user` carries a role and
        // nothing else, and BR01's profile filter is a VIEW concern read from a
        // URL parameter or a cookie. Passing `[]` would refuse every task with
        // a profile and break retry while looking like security.
        profiles: null,
      },
      // A retry puts the task back in the queue. The ingestion worker owns what
      // happens next -- inventing a second execution path here would be the
      // "alternate queue" P4-R08 is forbidden from creating, in another place.
      reExecute: async () => {},
      now: () => new Date(),
    },
    id,
  );

  if (!outcome.ok) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: outcome.reason, message: outcome.detail ?? outcome.reason },
      },
      { status: STATUS[outcome.reason] ?? 400 },
    );
  }

  return NextResponse.json({
    data: { attempt: outcome.attempt, attemptId: outcome.attemptId },
    meta: { request_id: requestId },
    error: null,
  });
}
