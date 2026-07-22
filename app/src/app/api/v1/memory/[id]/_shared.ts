import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRoleForApi } from "@/lib/authz";
import { reviewMemory, type MemoryAction, type MemoryActionErr } from "@/lib/memory/actions";

const bodySchema = z.object({
  reason: z.string().max(2000).optional(),
});

const ERROR_STATUS: Record<MemoryActionErr["code"], number> = {
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
};

export async function handleMemoryAction(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  action: MemoryAction,
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
    // OK cho approve
  }

  const result = await reviewMemory({
    memoryId: id,
    action,
    actorId: gate.session.user.email,
    reason,
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
    data: result.memory,
    meta: { request_id: requestId },
    error: null,
  });
}
