/**
 * IMP-02 / ORG-01, ORG-02, ORG-04 — pure helpers for the Organization screens (no I/O, shared by the UI and its tests).
 * Everything here is DERIVED from real configuration; nothing is invented. Where the app cannot enforce something, the label says so.
 */

export interface FunctionDecl {
  code: string; name: string;
  /** Who/what holds the function (initial proposal in PRD ORG-01). */
  holder: string;
  /** true = "chưa kích hoạt": nobody executes it yet; the owner is the decision point and NO bot profile exists for it. */
  inactive?: boolean;
  note?: string;
}
/** ORG-01: declarative map (not twelve bots). It is the INITIAL PROPOSAL of the PRD — the owner has not confirmed each assignment. */
export const COMPANY_FUNCTIONS: FunctionDecl[] = [
  { code: "DEP-01", name: "Chiến lược và quản trị", holder: "Chủ quyết định; AFF/YT cung cấp bằng chứng" },
  { code: "DEP-02", name: "Điều hành và dự án", holder: "Trưởng kế hoạch (AFF hoặc YT kiêm theo kế hoạch) + app giữ trạng thái" },
  { code: "DEP-03", name: "Nghiên cứu và đối tác", holder: "AFF chính; YT nghiên cứu nhu cầu nội dung" },
  { code: "DEP-04", name: "Sản phẩm và chào hàng", holder: "AFF nghiên cứu thương mại", inactive: true, note: "Chưa kích hoạt thực thi sản phẩm riêng (SAL-01)" },
  { code: "DEP-05", name: "Nội dung và sáng tạo", holder: "YT chính; AFF kiểm góc thương mại" },
  { code: "DEP-06", name: "Marketing và phân phối", holder: "AFF (paid/funnel), YT (kênh); theo công cụ thực có" },
  { code: "DEP-07", name: "Bán hàng và CRM", holder: "AFF kiêm", inactive: true, note: "Chưa kích hoạt CRM (CRM-01); khoảng trống ghi rõ" },
  { code: "DEP-08", name: "Khách hàng và bàn giao", holder: "Chưa có", inactive: true, note: "Chưa kích hoạt; ngoại lệ do Chủ xử lý" },
  { code: "DEP-09", name: "Tài chính và mua sắm", holder: "App tính và lưu sổ; AFF/YT gắn nguồn; Chủ cấp ngân sách và giấy ủy quyền (SR-17)" },
  { code: "DEP-10", name: "Dữ liệu và thử nghiệm", holder: "App thu/tính; AFF (thương mại), YT (nội dung) phân tích" },
  { code: "DEP-11", name: "Công nghệ và đội ngũ AI", holder: "App/Hermes + người triển khai được giao", note: "Không mặc định AFF/YT quản trị production" },
  { code: "DEP-12", name: "Chất lượng và rủi ro", holder: "AFF/YT kiểm chéo đúng chuyên môn; quy tắc app; chuyên gia/Chủ khi cần" },
];
export const DECISION_LEAD = "Chủ (OWNER)";

/** Three states kept apart (OFC-02): profile created / connected / executing. */
export interface AssistantLike {
  status: string; connection_state: string; connection_checked_at?: string | null; connection_error?: string | null;
  dispatch_enabled: boolean; dispatch_paused?: boolean; capability_mode: string; capability_ack_at?: string | null; tool_allowlist: string[];
  max_runs_per_day: number | null; run_deadline_seconds: number | null; max_continuations?: number | null; max_subtasks?: number | null;
  active_grants?: number; runs_in_flight?: number; hermes_profile: string | null;
}
export interface AssistantStates { profile: "Đã tạo hồ sơ" | "Đã lưu trữ"; connection: "Chưa kết nối" | "Đã kết nối (đã kiểm thật)" | "Kiểm tra lỗi"; execution: "Đang bật giao việc" | "Giao việc tắt" | "Đang chạy" | "Tạm dừng" }
export function assistantStates(a: AssistantLike): AssistantStates {
  return {
    profile: a.status === "ARCHIVED" ? "Đã lưu trữ" : "Đã tạo hồ sơ",
    connection: a.connection_state === "VERIFIED" ? "Đã kết nối (đã kiểm thật)" : a.connection_state === "FAILED" ? "Kiểm tra lỗi" : "Chưa kết nối",
    execution: (a.runs_in_flight ?? 0) > 0 ? "Đang chạy" : a.dispatch_paused ? "Tạm dừng" : a.dispatch_enabled ? "Đang bật giao việc" : "Giao việc tắt",
  };
}

export type Enforcement = "Mã ép" | "Mã ép một phần" | "Chỉ là lời dặn / chưa kiểm chứng" | "Không áp dụng";
export interface PermissionRow { level: "Q0" | "Q1" | "Q2" | "Q3" | "Q4"; title: string; active: boolean; basis: string; enforcement: Enforcement; caveat: string }
/**
 * ORG-04 / TDD 8.11.K: Q0–Q4 are DERIVED labels, never a stored enum or column. `active` is read from the real configuration;
 * `enforcement` says plainly where the app enforces and where it is only a declaration.
 */
export function derivePermissionLevels(a: AssistantLike): PermissionRow[] {
  const restricted = a.capability_mode !== "DECLARED_FULL";
  const connected = a.connection_state === "VERIFIED";
  const dispatching = connected && a.dispatch_enabled && a.status === "ACTIVE";
  return [
    { level: "Q0", title: "Đọc / đề xuất", active: restricted && connected, basis: restricted ? `chế độ RESTRICTED; công cụ ${a.tool_allowlist.join(", ") || "(chưa có)"}; đã kiểm thật ⇒ công cụ của profile nằm trong danh sách` : "chế độ công cụ rộng (DECLARED_FULL) — không áp dụng danh sách hẹp", enforcement: restricted ? "Mã ép một phần" : "Không áp dụng", caveat: "Kiểm lúc kiểm tra kết nối/bật giao việc, không phải mỗi lần bot gọi công cụ." },
    { level: "Q1", title: "Nghiên cứu có quỹ", active: dispatching, basis: `giao việc ${a.dispatch_enabled ? "bật" : "tắt"}; tối đa ${a.max_runs_per_day ?? "?"} lượt/ngày; hạn mỗi lượt ${a.run_deadline_seconds ?? "?"} giây`, enforcement: "Mã ép một phần", caveat: "Số lượt và thời gian do ứng dụng ép; chi phí tiền theo lượt chưa đo và không bị ép ở đây (hạn mức nằm ở nhà cung cấp)." },
    { level: "Q2", title: "Thực thi nội bộ", active: !restricted && !!a.capability_ack_at, basis: restricted ? "chưa khai báo công cụ rộng" : `công cụ rộng do Chủ xác nhận lúc ${a.capability_ack_at ?? "(chưa xác nhận)"}; việc con tối đa ${a.max_subtasks ?? 0}, tiếp tục tối đa ${a.max_continuations ?? 0}`, enforcement: "Chỉ là lời dặn / chưa kiểm chứng", caveat: "DECLARED_FULL là khai báo của Chủ; terminal/trình duyệt/tệp của bot không bị app chặn, chỉ thao tác đi qua công cụ của app mới được ghi và ép." },
    { level: "Q3", title: "Hành động bên ngoài", active: (a.active_grants ?? 0) > 0, basis: `${a.active_grants ?? 0} giấy ủy quyền còn hạn`, enforcement: "Mã ép một phần", caveat: "Chỉ hành động bot khai qua công cụ xin quyền được tính; chi thật bị chặn bởi hạn mức tài khoản ở nhà cung cấp." },
    { level: "Q4", title: "Quyết định của Chủ", active: true, basis: "mọi thao tác cấp/thu quyền, duyệt, bật giao việc chỉ OWNER làm được", enforcement: "Mã ép", caveat: "Dựa trên danh tính đăng nhập; với Telegram còn phụ thuộc tin cậy danh tính một người (U1)." },
  ];
}

/** Why a task would be refused for an assistant — the reason shown to the owner (ORG-02: "trả kèm lý do"). */
export function whyCannotTakeWork(a: AssistantLike & { open_tasks?: number }): string | null {
  if (a.status !== "ACTIVE") return "Trợ lý đã lưu trữ.";
  if (a.connection_state !== "VERIFIED") return a.connection_state === "FAILED" ? `Kiểm tra kết nối lỗi: ${a.connection_error ?? "(không rõ)"}` : "Chưa kết nối: cần kiểm tra kết nối thật trước.";
  if (!a.dispatch_enabled) return "Giao việc đang tắt.";
  if (a.dispatch_paused) return "Giao việc đang tạm dừng.";
  return null;
}

/** ORG-04: responsibilities by project stage (PRD ORG-04 table, verbatim in substance). Declarative text, shown read-only. */
export interface StageRow { stage: string; name: string; aff: string; yt: string; lead: string; level: string }
export const STAGE_RESPONSIBILITIES: StageRow[] = [
  { stage: "S1", name: "Khám phá", aff: "Hồ sơ cơ hội, offer, khách hàng, đối thủ có bằng chứng; xin YT đánh giá khán giả; được loại ứng viên có lý do", yt: "Hồ sơ khán giả, nhu cầu, chủ đề có nguồn; đề nghị AFF đánh giá cơ hội kiếm tiền; không sao chép trái phép hay bịa khảo sát", lead: "Làm rõ mục tiêu, phân nghiên cứu, chống trùng cơ hội; không tạo vòng nghiên cứu vô hạn", level: "Q1 theo quỹ chuẩn bị" },
  { stage: "S2", name: "Plan & Cost", aff: "Kế hoạch thử, góc tiếp cận, chi phí, giả thuyết, tiêu chí dừng, ước lượng chuyển đổi có giả định; chưa bật chiến dịch", yt: "Kế hoạch nội dung/kênh, lịch, công suất, chi sản xuất/phân phối, chỉ số, kỳ đánh giá; chưa mua tài sản/đặt dịch vụ", lead: "Kết hợp dự toán, phụ thuộc, trách nhiệm, quyền thành một Plan & Cost; không tự duyệt kế hoạch mình lập", level: "Q1" },
  { stage: "S3", name: "Chờ duyệt", aff: "Giải trình, sửa phiên bản, chuẩn bị thông tin còn được phép; không suy diễn im lặng thành duyệt", yt: "Chỉnh kế hoạch, nêu giới hạn kỹ thuật và sản xuất", lead: "Gửi đề xuất có phiên bản, tổng hợp câu hỏi và điều kiện duyệt, nhắc theo lịch cấu hình", level: "Q0/Q1 còn hiệu lực" },
  { stage: "S4", name: "Thực thi và phối hợp", aff: "Tạo tài sản, bàn giao YT, cấu hình tracking; ads/đăng ký/tiếp xúc đối tác nếu đã ủy quyền", yt: "Kịch bản, tài sản, video; kiểm chéo claim với AFF; xuất bản theo tiêu chí được ủy quyền", lead: "Giao/đổi người, sắp thứ tự, nhận báo cáo, xử lý kẹt trong biên; tạm dừng nhánh có vấn đề theo chính sách", level: "Q2; Q3 đúng tài khoản, ngân sách, thông điệp, phạm vi" },
  { stage: "S5", name: "Đo, điều chỉnh", aff: "Đọc dữ liệu, đối chiếu chất lượng traffic, điều chỉnh trong biên, xin thêm ngân sách; không tự tăng trần dù ROAS tốt", yt: "Theo dõi tiếp cận, giữ chân, click; thử tiêu đề/thumbnail trong biên; đổi chủ đề/phạm vi đáng kể thì đề xuất", lead: "Tổng hợp sai lệch, yêu cầu phân tích, trình thay đổi; chuyển hạn mức chỉ khi kế hoạch cho phép và không tăng trần", level: "Q2/Q3 hiện hành" },
  { stage: "S6", name: "Đối soát, báo cáo", aff: "Báo hoa hồng theo trạng thái, chi phí đầy đủ, kết quả thử, đề xuất tiếp; không biến doanh thu dự kiến thành đã thu", yt: "Bàn giao video/bài/tài sản có phiên bản, báo hiệu suất và chi phí; chưa có doanh thu thì không báo «đã có lợi nhuận»", lead: "Kiểm tra đủ báo cáo/đối soát, tổng hợp đóng dự án và bài học; không che khoản chưa đối soát", level: "Q2" },
];
export const CAPABILITY_STAGE = "G1 (đang hoàn tất M1 cho AFF/YT; IMP-02) — G2 kế hoạch xuyên suốt một bot đã có (IMP-01); G3–G5 chưa kích hoạt";
