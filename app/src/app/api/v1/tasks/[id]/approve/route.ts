import { type NextRequest } from "next/server";
import { handleReviewAction } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleReviewAction(req, ctx, "approve");
}
