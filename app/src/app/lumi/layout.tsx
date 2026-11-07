import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { LumiProvider } from "@/components/lumi/lumi-provider";
import { Shell } from "@/components/lumi/shell";
import { buildDbState } from "@/lib/lumi/db-state";
import { lumiDataMode } from "@/lib/lumi/data-mode";
import { readState } from "@/lib/lumi/store";
import { hermesModeLabel } from "@/lib/lumi-m1/hermes-port";
import { currentUser, lumiDb, lumiHermes } from "@/lib/lumi-m1/server";
import "./lumi.css";

// Dong-Lumi. "db" (LUMI_DATA=db): dữ liệu THẬT từ PostgreSQL, bắt buộc đăng nhập. "preview" (DONGLUMI_PREVIEW=1): mô phỏng, không đăng nhập.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Dong-Lumi" }, description: "Văn phòng trợ lý AI: giao việc, duyệt đầu ra" };

export default async function LumiLayout({ children }: { children: ReactNode }) {
  const mode = lumiDataMode();
  if (mode === "off") notFound();
  let initial;
  if (mode === "db") {
    const user = await currentUser();
    if (!user) redirect("/login?callbackUrl=/lumi");
    initial = await buildDbState(lumiDb(), user, { hermesMode: hermesModeLabel(lumiHermes()), telegramBot: process.env.LUMI_TELEGRAM_BOT });
  } else {
    initial = await readState();
  }
  return (
    <LumiProvider initial={initial}>
      <Shell>{children}</Shell>
    </LumiProvider>
  );
}
