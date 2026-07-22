import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRoleForApi } from "@/lib/authz";
import { reviewTask, type ReviewAction, type ReviewErr } from "@/lib/tasks/review";

const bodySchema = z.object({
  reason: z.string().max(2000).optional(),
});

const ERROR_STATUS: Record<ReviewErr["code"], number> = {
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  CONFLICT: 409,
  VALIDATION_ERROR: 400,
};

export async function handleReviewAction(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  action: ReviewAction,
): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN"], requestId);
  if ("error" in gate) return gate.error;

  const { id } = await ctx.params;

  let reason: string | undefined;
  try {
    const raw = (await req.json().catch(() => ({}))) as unknown;
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          data: null,
          meta: { request_id: requestId },
          error: { code: "VALIDATION_ERROR", message: "Body không hợp lệ" },
        },
        { status: 400 },
      );
    }
    reason = parsed.data.reason;
  } catch {
    // no body — OK cho approve
  }

  // AC05 — optimistic lock qua header If-Unmodified-Since (RFC 7232).
  let ifUnmodifiedSince: Date | undefined;
  const iusHeader = req.headers.get("if-unmodified-since");
  if (iusHeader) {
    const d = new Date(iusHeader);
    if (!Number.isNaN(d.getTime())) ifUnmodifiedSince = d;
  }

  const result = await reviewTask({
    taskId: id,
    action,
    actorId: gate.session.user.email,
    reason,
    ifUnmodifiedSince,
    requestId,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: result.code, message: result.message },
      },
      { status: ERROR_STATUS[result.code] },
    );
  }

  return NextResponse.json({
    data: result.task,
    meta: { request_id: requestId },
    error: null,
  });
}
