import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRoleForApi } from "@/lib/authz";
import { createOffer, listOffers } from "@/lib/aff/offers";
import { offerStatusEnum } from "@/lib/db/schema/aff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(2).max(200),
  websiteUrl: z.string().url().max(500).optional().nullable(),
  network: z.string().max(200).optional().nullable(),
  marketId: z.string().uuid().optional().nullable(),
  commissionType: z.enum(["CPA", "REVSHARE", "RECURRING", "HYBRID", "UNKNOWN"]).default("UNKNOWN"),
  commissionValue: z.number().optional().nullable(),
  commissionUnit: z.string().max(50).optional().nullable(),
  cookieDays: z.number().int().optional().nullable(),
  countries: z.array(z.string().max(4)).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
});

export async function GET(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN", "VIEWER"], requestId);
  if ("error" in gate) return gate.error;

  const status = req.nextUrl.searchParams.get("status");
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const validStatus = status && (offerStatusEnum.enumValues as string[]).includes(status);

  const items = await listOffers({
    status: validStatus ? (status as (typeof offerStatusEnum.enumValues)[number]) : "all",
    q,
  });
  return NextResponse.json({
    data: { items },
    meta: { request_id: requestId },
    error: null,
  });
}

export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN"], requestId);
  if ("error" in gate) return gate.error;

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
  const parsed = createSchema.safeParse(body);
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

  const result = await createOffer({
    ...parsed.data,
    actorId: gate.session.user.email,
    requestId,
  });
  if (!result.ok) {
    const status = result.code === "CONFLICT" ? 409 : 400;
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: result.code, message: result.message },
      },
      { status },
    );
  }
  return NextResponse.json(
    { data: result.offer, meta: { request_id: requestId }, error: null },
    { status: 201 },
  );
}
