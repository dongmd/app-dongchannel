import { lumiRoute } from "@/lib/lumi-m1/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = lumiRoute("listYtStrategy");
export const POST = lumiRoute("setYtStrategy");
