import { NextResponse } from "next/server";
import { requireRoleForApi } from "@/lib/authz";
import { pingHermesStatus } from "@/lib/hermes/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AC06 — envelope {data, meta, error} theo TDD mục 20.
// Role guard OWNER/ADMIN đồng bộ với UI (AC01) — backend enforce, không dựa vào UI hide.
export async function GET() {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN"], requestId);
  if ("error" in gate) return gate.error;

  const status = await pingHermesStatus();
  return NextResponse.json({
    data: status,
    meta: { request_id: requestId },
    error: null,
  });
}
