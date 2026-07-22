import { type NextRequest } from "next/server";
import { handleMemoryAction } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleMemoryAction(req, ctx, "approve");
}
