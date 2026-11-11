"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/** KNW-14 from the task side: which knowledge (item + version) each run of this task was given, and a warning when a newer version has been approved since. */
import { useEffect, useState } from "react";

import { lumiApi } from "@/lib/lumi/plans-client";
import { LumiLink } from "./ui";

export function LoadedKnowledge({ uuid }: { uuid: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => lumiApi(`/api/v1/tasks/${uuid}/knowledge`).then((r) => { if (alive && r.ok) setRows(r.data.loaded); });
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [uuid]);
  if (rows === null || rows.length === 0) return null;
  return (
    <div className="l-card" style={{ marginBottom: 12 }} data-testid="loaded-knowledge">
      <div className="l-label" style={{ marginTop: 0 }}>Kiến thức đã nạp cho việc này</div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {rows.map((r, i) => (
          <li key={i} data-testid={`lk-${r.code}-${r.attempt_no}`}>
            Lượt {r.attempt_no}: <LumiLink href="/lumi/knowledge"><u>{r.code}</u></LumiLink> bản {r.used_version} · {r.title}
            {r.changed_since && <span className="l-badge amber" style={{ marginLeft: 6 }} data-testid="lk-changed">quy tắc đã đổi sau khi việc này chạy (nay là bản {r.current_version})</span>}
          </li>
        ))}
      </ul>
      <div className="small muted" style={{ marginTop: 4 }}>Chỉ là chỉ dẫn cho bot, không phải quyền hành động hay ngân sách.</div>
    </div>
  );
}
