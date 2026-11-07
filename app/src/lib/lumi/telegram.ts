// Phân tích tin nhắn Telegram mô phỏng. Hàm thuần: không gọi model, không gửi Telegram thật.
import type { Project } from "./types.ts";

export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export type Intent = { kind: "task"; body: string } | { kind: "chat"; body: string };

/** /viec <nội dung> hoặc "Giao việc: <nội dung>" là lệnh giao việc; còn lại là chat thường. */
export function parseIntent(text: string): Intent {
  const t = text.trim();
  const slash = /^\/viec(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t);
  if (slash) return { kind: "task", body: (slash[1] ?? "").trim() };
  if (/^giao\s+viec\s*:/.test(fold(t))) {
    return { kind: "task", body: t.slice(t.indexOf(":") + 1).trim() };
  }
  return { kind: "chat", body: t };
}

export function inferProject(text: string, projects: Project[]): Project | undefined {
  const f = fold(text);
  return projects.find((p) => p.status === "active" && f.includes(fold(p.name)));
}

export function inferOutput(text: string): string {
  const f = fold(text);
  const m = /(\d+|ba|hai|bon|nam)\s*mau\s*quang cao/.exec(f);
  if (m) {
    const n = m[1] === "ba" ? "3" : m[1] === "hai" ? "2" : m[1] === "bon" ? "4" : m[1] === "nam" ? "5" : m[1];
    return `${n} mẫu quảng cáo`;
  }
  if (/dan y/.test(f)) return "Dàn ý";
  if (/kich ban/.test(f)) return "Kịch bản";
  if (/bao cao|tom tat/.test(f)) return "Bản tóm tắt";
  return "Bản nháp kết quả";
}

export function inferDue(text: string): string | undefined {
  const m = /(?:han|truoc|deadline)\s*[:\-]?\s*([^,.;\n]+)/i.exec(fold(text));
  if (!m || !m[1]) return undefined;
  // Lấy phần gốc có dấu tương ứng theo vị trí.
  const idx = fold(text).indexOf(m[1]);
  return text.slice(idx, idx + m[1].length).trim() || undefined;
}

export function makeTitle(body: string): string {
  const b = body.replace(/\s+/g, " ").trim();
  if (!b) return "Việc mới";
  const t = b.charAt(0).toUpperCase() + b.slice(1);
  return t.length > 90 ? `${t.slice(0, 87)}…` : t;
}
