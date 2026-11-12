/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 7 — integration readiness. For each outside system: is it configured on THIS server (only whether the variables exist, never their values), has it ever worked
 * (evidence from the database, not from a flag), and exactly what the owner must supply. Nothing here calls the outside system.
 */
import type { Db } from "./core";

type St = "READY" | "PARTIAL" | "MISSING" | "NOT_BUILT";
const has = (env: Record<string, string | undefined>, k: string) => typeof env[k] === "string" && env[k]!.trim().length > 0;

export async function integrationsStatus(db: Db, env: Record<string, string | undefined> = process.env) {
  const [probe] = await db.query<any>(`SELECT count(*)::int n FROM lumi_run_cost_probes WHERE state='MEASURED'`);
  const [verified] = await db.query<any>(`SELECT count(*)::int n FROM lumi_assistants WHERE connection_state='VERIFIED'`);
  const [tg] = await db.query<any>(`SELECT count(*)::int n FROM lumi_outbox WHERE kind='TELEGRAM_NOTIFY' AND status='DONE'`).catch(() => [{ n: 0 }]);
  const group = (vars: string[]): { st: St; set: string[]; missing: string[] } => {
    const set = vars.filter((v) => has(env, v)); const missing = vars.filter((v) => !has(env, v));
    return { st: missing.length === 0 ? "READY" : set.length === 0 ? "MISSING" : "PARTIAL", set, missing };
  };
  const items: any[] = [];
  const add = (key: string, name: string, vars: string[] | null, evidence: string, needs: string, codes: string, builtNote?: string) => {
    if (vars === null) { items.push({ key, name, status: "NOT_BUILT", vars: [], missing: [], evidence, needs, codes, note: builtNote ?? "Chưa có mã tích hợp trong ứng dụng." }); return; }
    const g = group(vars); items.push({ key, name, status: g.st, vars, set: g.set, missing: g.missing, evidence, needs, codes, note: builtNote ?? null });
  };
  add("google", "Đăng nhập Google (Chủ/Admin/Viewer)", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "AUTH_EMAIL_ALLOWLIST", "NEXTAUTH_SECRET"], "Bạn đang đăng nhập được thì mục này đang chạy.", "Thêm email vào danh sách cho phép để có tài khoản ADMIN/VIEWER.", "ADM-02");
  add("hermes", "Hermes (bot thật)", ["HERMES_API_BASE_URL"], `${verified?.n ?? 0} trợ lý đã được kiểm tra kết nối thật (đếm từ CSDL). Chế độ app: ${env.LUMI_HERMES_MODE ?? "chưa đặt"}.`, "Hermes chạy trên máy dlumi; worker dùng SSH nội bộ. Biến này chỉ cần cho màn quản trị.", "OFC-04, ADM-07");
  add("telegram", "Telegram (bot app)", ["LUMI_TELEGRAM_BOT", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_OWNER_IDS"], `Tin Telegram đã gửi thành công qua hàng chờ: ${tg?.n ?? 0}.`, "Quyết định Q14 (bot app khác bot Hermes), token bot, ID Telegram của Chủ; đăng ký webhook.", "TGM-01..07, DSH-06");
  add("wordpress", "WordPress (dongchannel.com)", ["WORDPRESS_BASE_URL", "WORDPRESS_INTEGRATION_USER", "WORDPRESS_APPLICATION_PASSWORD"], "Chưa có xác nhận lần gọi thành công từ ứng dụng.", "Địa chỉ site, tài khoản tích hợp và Application Password; kiểm kê hosting (U9) và thông tin Q17.", "WEB-*, WRD-*, WAF-*, AGT-08");
  add("openrouter", "Chi phí AI đo thật (khóa OpenRouter riêng)", [], probe?.n > 0 ? `Đã có ${probe.n} lượt đo thật thành công.` : "Chưa có lượt nào đo thật thành công; cần một lượt của bot có khóa riêng.", "Khóa nằm ở máy worker (không hiện trong ứng dụng).", "ECO-03, CST-01");
  items[items.length - 1].status = probe?.n > 0 ? "READY" : "PARTIAL";
  add("affiliate_net", "Mạng affiliate (Impact…) — số liệu tự động", null, "Số liệu hiện do người nhập (Tài chính / màn AFF cũ).", "Tài khoản và quyền đọc API của mạng; quyết định đồng bộ tự động.", "AFF-02, MOS-04");
  add("youtube_api", "YouTube Analytics API", null, "Hiệu suất video hiện nhập tay.", "OAuth kênh YouTube (chỉ quyền đọc) và quyết định phạm vi.", "YTB-02");
  add("ga4_gsc", "GA4 / Search Console / click /go/", null, "Chưa có số liệu phản hồi từ website.", "Quyền đọc GA4 và Search Console cho site.", "MOS-04 (chế độ 6), WEB-*");
  const ready = items.filter((i) => i.status === "READY").length;
  return { items, ready, total: items.length, note: "Chỉ kiểm biến cấu hình có mặt trên máy chủ và bằng chứng trong CSDL; không gọi hệ thống bên ngoài và không bao giờ hiện giá trị khóa." };
}
