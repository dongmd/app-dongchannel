import { isLumiDbMode } from "./data-mode";

/**
 * Cờ bật bản preview Dong-Lumi (/lumi, /api/lumi). Mặc định TẮT.
 *
 * Preview không có đăng nhập và dùng dữ liệu mô phỏng lưu trong file, nên chỉ được bật khi
 * `DONGLUMI_PREVIEW=1` và KHÔNG khi NEXTAUTH_URL trỏ vào app.dongchannel.com. Hai điều kiện này
 * ngăn việc vô tình bật trên production.
 *
 * Chế độ dữ liệu thật (LUMI_DATA=db) luôn tắt preview: đường không đăng nhập không được tồn tại cạnh dữ liệu thật.
 */
export function isLumiPreviewEnabled(): boolean {
  if (isLumiDbMode()) return false;
  if (process.env.DONGLUMI_PREVIEW !== "1") return false;
  const authUrl = process.env.NEXTAUTH_URL ?? "";
  if (/dongchannel\.com/i.test(authUrl)) return false;
  return true;
}

export function isLumiPreviewPath(pathname: string): boolean {
  return pathname === "/lumi" || pathname.startsWith("/lumi/") || pathname.startsWith("/api/lumi/");
}
