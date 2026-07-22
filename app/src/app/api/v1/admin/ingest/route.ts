import { NextResponse, type NextRequest } from "next/server";
import { requireRoleForApi } from "@/lib/authz";
import { ingestAll, ingestProfile } from "@/lib/ingestion/hermes-projector";
import { PROFILE_SLUGS, type ProfileSlug } from "@/lib/db/schema/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// AC05 — manual trigger ingest. Role OWNER/ADMIN, envelope response.
// POST ?profile=aff|yt|default|all
export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN"], requestId);
  if ("error" in gate) return gate.error;

  const profileParam = req.nextUrl.searchParams.get("profile") ?? "all";
  const isKnown = (v: string): v is ProfileSlug => (PROFILE_SLUGS as readonly string[]).includes(v);

  try {
    if (profileParam === "all") {
      const results = await ingestAll();
      return NextResponse.json({ data: results, meta: { request_id: requestId }, error: null });
    }
    if (!isKnown(profileParam)) {
      return NextResponse.json(
        {
          data: null,
          meta: { request_id: requestId },
          error: { code: "VALIDATION_ERROR", message: "profile phải là aff|yt|default|all" },
        },
        { status: 400 },
      );
    }
    const result = await ingestProfile(profileParam);
    return NextResponse.json({ data: result, meta: { request_id: requestId }, error: null });
  } catch (err) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: "UPSTREAM_UNAVAILABLE", message: (err as Error).message },
      },
      { status: 502 },
    );
  }
}
