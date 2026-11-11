"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/** ECO-03: AI cost per assistant as MEASURED from the provider key usage, and the runs whose cost is unknown with the reason. Unknown is never shown as zero. */
import { useEffect, useState } from "react";

import { lumiApi } from "@/lib/lumi/plans-client";

export function CostCard() {
  const [d, setD] = useState<any | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => lumiApi("/api/v1/lumi/cost").then((r) => { if (alive && r.ok) setD(r.data); });
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!d || (d.assistants as any[]).length === 0) return null;
  return (
    <section className="l-card" data-testid="cost-card">
      <h3 style={{ margin: "0 0 6px" }}>Chi phí AI đo thật theo lượt</h3>
      <p className="small muted" style={{ marginTop: 0 }}>{d.note}</p>
      <div style={{ overflowX: "auto" }}>
        <table className="l-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
          <thead><tr><th align="left">Trợ lý</th><th align="right">Lượt chạy</th><th align="right">Đo được</th><th align="right">Chưa biết</th><th align="right">Chi phí đo được ({d.currency})</th></tr></thead>
          <tbody>
            {(d.assistants as any[]).map((a) => (
              <tr key={a.slug} data-testid={`cost-${a.slug}`}>
                <td>{a.name}</td><td align="right">{a.runs_total}</td><td align="right">{a.runs_measured}</td>
                <td align="right">{a.runs_unknown}{a.runs_pending > 0 ? ` (+${a.runs_pending} đang chờ đọc)` : ""}</td>
                <td align="right"><strong>{Number(a.measured_amount).toFixed(4)}</strong>{a.runs_unknown > 0 ? <span className="muted"> + chưa biết</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(d.assistants as any[]).some((a) => a.unknown_reasons.length > 0) && (
        <details style={{ marginTop: 6 }}><summary className="small">Vì sao một số lượt chưa biết chi phí</summary>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(d.assistants as any[]).flatMap((a) => (a.unknown_reasons as any[]).map((x, i) => <li key={`${a.slug}-${i}`}>{a.name}: {x.text} ({x.runs} lượt)</li>))}</ul>
        </details>
      )}
    </section>
  );
}
