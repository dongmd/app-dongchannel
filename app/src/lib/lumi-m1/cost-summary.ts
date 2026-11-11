/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/** Read model for "Chi phí AI đo thật": per assistant, what was measured (provider key usage), what is unknown and WHY. Unknown is never shown as 0. */
import type { Db } from "./core";
import { PROBE_REASON_TEXT } from "./cost-probe";

export async function buildCostSummary(db: Db) {
  const rows = await db.query<any>(
    `SELECT a.slug,a.name,
            count(r.id)::int AS runs_total,
            count(r.id) FILTER (WHERE pr.state='MEASURED')::int AS runs_measured,
            coalesce(sum(CASE WHEN pr.state='MEASURED' THEN pr.after_usage-pr.before_usage END),0)::float AS measured_amount,
            count(r.id) FILTER (WHERE pr.state='PENDING')::int AS runs_pending,
            count(r.id) FILTER (WHERE r.state IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','ABANDONED','STOPPED_CAP') AND coalesce(pr.state,'NONE') NOT IN ('MEASURED','PENDING'))::int AS runs_unknown,
            max(pr.after_usage)::float AS last_key_usage
       FROM lumi_assistants a JOIN lumi_task_runs r ON r.assistant_id=a.id LEFT JOIN lumi_run_cost_probes pr ON pr.run_id=r.id
      GROUP BY a.slug,a.name ORDER BY a.name`);
  const reasons = await db.query<any>(`SELECT a.slug, coalesce(pr.reason,'NO_PROBE') AS reason, count(*)::int AS n FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id LEFT JOIN lumi_run_cost_probes pr ON pr.run_id=r.id WHERE r.state IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','ABANDONED','STOPPED_CAP') AND coalesce(pr.state,'NONE') NOT IN ('MEASURED','PENDING') GROUP BY 1,2`);
  return {
    currency: "USD",
    assistants: rows.map((r: any) => ({ ...r, unknown_reasons: reasons.filter((x: any) => x.slug === r.slug).map((x: any) => ({ reason: x.reason, text: x.reason === "NO_PROBE" ? "Không có thăm dò (bản chạy mô phỏng hoặc lượt trước khi bật đo)" : PROBE_REASON_TEXT[x.reason] ?? x.reason, runs: x.n })) })),
    note: "Số đo là mức tăng mức sử dụng của KHÓA nhà cung cấp RIÊNG của trợ lý, đọc trước và sau mỗi lượt chạy. Lượt chồng nhau, khóa dùng chung hoặc không đọc được thì chi phí ghi «chưa biết», không phải 0. Hạn mức chi thật vẫn nằm ở tài khoản nhà cung cấp.",
  };
}
