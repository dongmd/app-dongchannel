import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRoleForApi } from "@/lib/authz";
import { createVideo, listVideos } from "@/lib/youtube/videos";
import { videoStatusEnum } from "@/lib/db/schema/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  workingTitle: z.string().min(2).max(300),
  nicheId: z.string().uuid().optional().nullable(),
  offerId: z.string().uuid().optional().nullable(),
  hook: z.string().max(2000).optional().nullable(),
  outline: z.string().max(10000).optional().nullable(),
});

export async function GET(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN", "VIEWER"], requestId);
  if ("error" in gate) return gate.error;

  const status = req.nextUrl.searchParams.get("status");
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const validStatus = status && (videoStatusEnum.enumValues as string[]).includes(status);

  const items = await listVideos({
    status: validStatus ? (status as (typeof videoStatusEnum.enumValues)[number]) : "all",
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
  const result = await createVideo({
    ...parsed.data,
    actorId: gate.session.user.email,
    requestId,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: result.code, message: result.message },
      },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { data: result.video, meta: { request_id: requestId }, error: null },
    { status: 201 },
  );
}
