/**
 * Nguồn dữ liệu của giao diện Dong-Lumi (/lumi):
 *  - "db"      LUMI_DATA=db: dữ liệu THẬT trong PostgreSQL, bắt buộc đăng nhập (trang, /api/lumi/state, /api/lumi/action).
 *  - "preview" DONGLUMI_PREVIEW=1: dữ liệu mô phỏng trong file, không đăng nhập (xem preview-flag.ts).
 *  - "off"     mặc định: /lumi trả 404.
 * "db" thắng "preview": nếu cả hai cùng được đặt thì KHÔNG bao giờ có đường vào không đăng nhập tới dữ liệu thật.
 */
export type LumiDataMode = "db" | "preview" | "off";

export function isLumiDbMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.LUMI_DATA === "db";
}

export function lumiDataMode(env: Record<string, string | undefined> = process.env): LumiDataMode {
  if (isLumiDbMode(env)) return "db";
  if (env.DONGLUMI_PREVIEW === "1" && !/dongchannel\.com/i.test(env.NEXTAUTH_URL ?? "")) return "preview";
  return "off";
}
