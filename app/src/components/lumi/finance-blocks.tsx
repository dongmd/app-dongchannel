"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/** DSH-05 (result per area) and DSH-07 (assistant health + today's measured AI cost). Every number says where it comes from; no data ⇒ "chưa có dữ liệu". */
import { useEffect, useState } from "react";

import { lumiApi } from "@/lib/lumi/plans-client";
import { fmtFull, LumiLink } from "./ui";

const AREA: Record<string, string> = { AFFILIATE: "Affiliate", YOUTUBE: "YouTube", WEBSITE: "Website", OTHER: "Khác" };
const money = (by: Record<string, number>) => { const e = Object.entries(by); return e.length ? e.map(([c, v]) => `${Number(v).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} ${c}`).join(" + ") : "—"; };

export function FinanceBlocks() {
  const [d, setD] = useState<any | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => lumiApi("/api/v1/lumi/dashboard-finance").then((r) => { if (alive && r.ok) setD(r.data); });
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!d) return null;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="finance-blocks">
      <section className="l-card" data-testid="area-results">
        <h3 style={{ margin: "0 0 4px" }}>Kết quả theo mảng <LumiLink href="/lumi/finance" className="small muted"><u>mở Tài chính</u></LumiLink></h3>
        <p className="small muted" style={{ marginTop: 0 }}>Số do người nhập kèm nguồn; không cộng thành lợi nhuận; «đã trả» mới là tiền đã nhận, «pipeline» không phải tiền thu.</p>
        <div style={{ overflowX: "auto" }}>
          <table className="l-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
            <thead><tr><th align="left">Mảng</th><th align="right">Chi phí QC</th><th align="right">Hoa hồng đã trả</th><th align="right">Tài trợ đã trả</th><th align="right">Pipeline</th><th align="left">Nguồn / cập nhật</th></tr></thead>
            <tbody>{(d.areas as any[]).map((a) => a.has_data ? (
              <tr key={a.area} data-testid={`area-${a.area}`}><td>{AREA[a.area]}</td><td align="right">{money(a.ads_cost)}</td><td align="right">{money(a.commission_paid)}</td><td align="right">{money(a.sponsor_paid)}</td><td align="right">{money(a.pipeline)}</td><td className="small">{(a.sources as string[]).join("; ")} · {fmtFull(a.updated_at)}</td></tr>
            ) : (
              <tr key={a.area} data-testid={`area-${a.area}`}><td>{AREA[a.area]}</td><td colSpan={5} className="muted">chưa có dữ liệu (không tự điền)</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <section className="l-card" data-testid="assistant-health">
        <h3 style={{ margin: "0 0 4px" }}>Tình trạng trợ lý</h3>
        <div style={{ overflowX: "auto" }}>
          <table className="l-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
            <thead><tr><th align="left">Trợ lý</th><th align="left">Kết nối Hermes</th><th align="right">Đang thực thi</th><th align="right">Việc chờ kết nối</th><th align="right">Lượt hôm nay</th><th align="right">Chi phí AI hôm nay (đo thật, USD)</th></tr></thead>
            <tbody>{(d.health as any[]).map((h) => (
              <tr key={h.slug} data-testid={`health-${h.slug}`}>
                <td>{h.name}</td><td>{h.connection_state === "VERIFIED" ? "đã kết nối (đã kiểm thật)" : h.connection_state === "FAILED" ? "lỗi kiểm tra" : "chưa kết nối"}{h.dispatch_enabled ? "" : " · giao việc tắt"}</td>
                <td align="right">{h.running}</td><td align="right">{h.waiting_connection}</td><td align="right">{h.runs_today}</td>
                <td align="right">{Number(h.cost_today_measured).toFixed(4)}{h.runs_unknown_today > 0 ? <span className="muted"> + {h.runs_unknown_today} lượt chưa biết</span> : null}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
