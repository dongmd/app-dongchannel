import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRoleForApi } from "@/lib/authz";
import { transitionOffer } from "@/lib/aff/offers";
import { offerStatusEnum } from "@/lib/db/schema/aff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  toStatus: z.enum(offerStatusEnum.enumValues),
  reason: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN"], requestId);
  if ("error" in gate) return gate.error;
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: "VALIDATION_ERROR", message: "Body không phải JSON hợp lệ." },
      },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        },
      },
      { status: 400 },
    );
  }

  const result = await transitionOffer({
    offerId: id,
    toStatus: parsed.data.toStatus,
    reason: parsed.data.reason,
    actorId: gate.session.user.email,
    requestId,
  });
  if (!result.ok) {
    const status = result.code === "NOT_FOUND" ? 404 : 409;
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: result.code, message: result.message },
      },
      { status },
    );
  }
  return NextResponse.json({
    data: result.offer,
    meta: { request_id: requestId },
    error: null,
  });
}
