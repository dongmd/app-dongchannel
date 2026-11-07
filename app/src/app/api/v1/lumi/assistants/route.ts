import { lumiRoute } from "@/lib/lumi-m1/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = lumiRoute("listAssistants");
export const POST = lumiRoute("createAssistant");
