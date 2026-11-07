import { NextResponse } from "next/server";

import { buildDbState } from "@/lib/lumi/db-state";
import { lumiDataMode } from "@/lib/lumi/data-mode";
import { readState } from "@/lib/lumi/store";
import { hermesModeLabel } from "@/lib/lumi-m1/hermes-port";
import { currentUser, lumiDb, lumiHermes } from "@/lib/lumi-m1/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dong-Lumi: trạng thái. "db" = dữ liệu thật (bắt buộc đăng nhập); "preview" = mô phỏng; còn lại 404.
export async function GET() {
  const mode = lumiDataMode();
  if (mode === "off") return new NextResponse(null, { status: 404 });
  if (mode === "db") {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    const state = await buildDbState(lumiDb(), user, { hermesMode: hermesModeLabel(lumiHermes()), telegramBot: process.env.LUMI_TELEGRAM_BOT });
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(await readState(), { headers: { "Cache-Control": "no-store" } });
}
