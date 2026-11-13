import { lumiRoute } from "@/lib/lumi-m1/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = lumiRoute("listCampaigns");
export const POST = lumiRoute("createCampaign");
