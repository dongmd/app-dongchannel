import { NextResponse, type NextRequest } from "next/server";

import { applyDbAction, buildDbState } from "@/lib/lumi/db-state";
import { lumiDataMode } from "@/lib/lumi/data-mode";
import type { Action } from "@/lib/lumi/engine";
import { mutate, resetState } from "@/lib/lumi/store";
import { hermesModeLabel } from "@/lib/lumi-m1/hermes-port";
import { currentUser, lumiDb, lumiHermes } from "@/lib/lumi-m1/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dong-Lumi: thực hiện một hành động. "db": qua lõi M1 thật (quyền theo vai trò, chống trùng, kiểm toán). "preview": mô phỏng.
export async function POST(req: NextRequest) {
  const mode = lumiDataMode();
  if (mode === "off") return new NextResponse(null, { status: 404 });
  if (mode === "db" && !(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json({ result: { ok: false, code: "invalid", message: "Cần application/json" } }, { status: 415 });
  }
  let body: { action?: Action; reset?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ result: { ok: false, code: "invalid", message: "JSON không hợp lệ" } }, { status: 400 });
  }
  if (mode === "db") {
    const user = await currentUser();
    if (!user) return NextResponse.json({ result: { ok: false, code: "invalid", message: "Cần đăng nhập" } }, { status: 401 });
    if (body.reset === true) return NextResponse.json({ result: { ok: false, code: "invalid", message: "Không có đặt lại ở dữ liệu thật." } }, { status: 400 });
    if (!body.action || typeof body.action !== "object" || typeof (body.action as { type?: unknown }).type !== "string") {
      return NextResponse.json({ result: { ok: false, code: "invalid", message: "Thiếu action" } }, { status: 400 });
    }
    if (user.role === "VIEWER") return NextResponse.json({ result: { ok: false, code: "invalid", message: "Bạn chỉ có quyền xem." }, state: await buildDbState(lumiDb(), user, { hermesMode: hermesModeLabel(lumiHermes()), telegramBot: process.env.LUMI_TELEGRAM_BOT }) });
    const result = await applyDbAction(lumiDb(), user, body.action, new Date(), lumiHermes());
    const state = await buildDbState(lumiDb(), user, { hermesMode: hermesModeLabel(lumiHermes()), telegramBot: process.env.LUMI_TELEGRAM_BOT });
    return NextResponse.json({ result, state }, { headers: { "Cache-Control": "no-store" } });
  }
  if (body.reset === true) {
    const state = await resetState();
    return NextResponse.json({ result: { ok: true }, state });
  }
  if (!body.action || typeof body.action !== "object" || typeof (body.action as { type?: unknown }).type !== "string") {
    return NextResponse.json({ result: { ok: false, code: "invalid", message: "Thiếu action" } }, { status: 400 });
  }
  const { result, state } = await mutate(body.action);
  return NextResponse.json({ result, state }, { headers: { "Cache-Control": "no-store" } });
}
