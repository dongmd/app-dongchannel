import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    data: {
      status: "ok",
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
      timestamp: new Date().toISOString(),
    },
    meta: { request_id: crypto.randomUUID() },
    error: null,
  });
}
