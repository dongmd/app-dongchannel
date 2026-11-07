"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";

import { project, searchMemories, SCOPE_LABEL } from "@/lib/lumi/selectors";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull, LumiLink } from "./ui";

const KIND_LABEL = { decision: "Quyết định", rule: "Quy tắc" } as const;
const STATUS_LABEL = { active: "Đang áp dụng", proposed: "Chờ duyệt", rejected: "Đã bỏ" } as const;

export function MemoryView() {
  const { state } = useLumi();
  const sp = useSearchParams();
  const [q, setQ] = useState("");
  const [pid, setPid] = useState("");
  const [sel, setSel] = useState<string | null>(sp.get("id"));
  const results = searchMemories(state, q, pid || undefined);
  const m = sel ? state.memories.find((x) => x.id === sel) : undefined;

  return (
    <div className="l-grid" style={{ gap: 16 }}>
      <div>
        <h1>Bộ nhớ</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>Tìm lại quyết định và quy tắc, kèm lý do, nguồn và việc liên quan.</p>
      </div>
      <div className="l-row">
        <div style={{ position: "relative", flex: "1 1 260px" }}>
          <Search size={16} style={{ position: "absolute", left: 11, top: 11, color: "var(--l-muted)" }} aria-hidden />
          <input className="l-input" style={{ paddingLeft: 34 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm theo từ khóa, ví dụ: Google Search" aria-label="Tìm trong bộ nhớ" type="search" />
        </div>
        <select className="l-select" style={{ width: "auto" }} value={pid} onChange={(e) => setPid(e.target.value)} aria-label="Lọc theo dự án">
          <option value="">Tất cả dự án</option>
          {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="l-split">
        <div className="l-grid" style={{ gap: 8 }} data-testid="memory-results">
          <div className="small muted">{results.length} kết quả</div>
          {results.length === 0 && <Empty>Không thấy kết quả nào.</Empty>}
          {results.map((r) => (
            <button key={r.id} className="l-card click" style={{ textAlign: "left", color: "inherit", font: "inherit", borderColor: sel === r.id ? "var(--l-accent)" : undefined }} onClick={() => setSel(r.id)} data-memory={r.id}>
              <div className="l-row" style={{ gap: 6 }}>
                <span className="l-badge purple">{KIND_LABEL[r.kind]}</span>
                <span className={`l-badge ${r.status === "active" ? "green" : "amber"}`}>{STATUS_LABEL[r.status]}</span>
                <span className="l-badge">{r.projectId ? project(state, r.projectId)?.name : "Cá nhân"}</span>
              </div>
              <div style={{ fontWeight: 650, marginTop: 6 }}>{r.text}</div>
              <div className="small muted">{r.content}</div>
            </button>
          ))}
        </div>
        <div>
          {!m ? (
            <div className="l-card"><Empty>Chọn một kết quả để xem nội dung, lý do, nguồn và việc liên quan.</Empty></div>
          ) : (
            <article className="l-card" aria-label="Chi tiết" data-testid="memory-detail">
              <div className="l-row" style={{ gap: 6 }}>
                <span className="l-badge purple">{KIND_LABEL[m.kind]}</span>
                <span className={`l-badge ${m.status === "active" ? "green" : "amber"}`}>{STATUS_LABEL[m.status]}</span>
                <span className="l-badge">{SCOPE_LABEL[m.scope]}{m.scope === "area" && m.area ? ` · ${m.area}` : ""}</span>
                {m.projectId && <span className="l-badge blue">{project(state, m.projectId)?.name}</span>}
              </div>
              <h2 style={{ margin: "8px 0 4px", fontSize: "1.15rem" }}>{m.text}</h2>
              <div className="l-label">Nội dung</div>
              <div>{m.content}</div>
              <div className="l-label">Lý do</div>
              <div>{m.reason}</div>
              {m.sourceMemoryId && (() => {
                const src = state.memories.find((x) => x.id === m.sourceMemoryId);
                return src ? (
                  <>
                    <div className="l-label">Quyết định nguồn</div>
                    <button className="l-chiplink" onClick={() => setSel(src.id)} data-testid="source-link">{src.text}</button>
                  </>
                ) : null;
              })()}
              {m.kind === "decision" && (() => {
                const rules = state.memories.filter((x) => x.sourceMemoryId === m.id && x.status !== "rejected");
                return rules.length > 0 ? (
                  <>
                    <div className="l-label">Quy tắc rút ra từ quyết định này</div>
                    <div className="l-row">
                      {rules.map((r) => <button key={r.id} className="l-chiplink" onClick={() => setSel(r.id)}>{r.text} · {STATUS_LABEL[r.status]}</button>)}
                    </div>
                  </>
                ) : null;
              })()}
              <div className="l-label">Nguồn / bằng chứng</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {m.evidence.map((e) => <li key={e.label}><strong>{e.label}:</strong> {e.note}</li>)}
              </ul>
              <div className="l-label">Thời điểm</div>
              <div>{fmtFull(m.at)}{m.proposedBy ? ` · đề xuất bởi ${state.members.find((x) => x.id === m.proposedBy)?.name ?? "trợ lý"}` : ""}</div>
              <div className="l-label">Việc liên quan</div>
              <div className="l-row">
                {m.taskIds.length === 0 && <span className="muted">Không có</span>}
                {m.taskIds.map((id) => {
                  const t = state.tasks.find((x) => x.id === id);
                  return t ? <LumiLink key={id} className="l-badge blue" href={`/lumi/projects/${t.projectId}?task=${t.id}`}>{t.id} · {t.title}</LumiLink> : null;
                })}
              </div>
              {m.status === "proposed" && (
                <div className="l-note" style={{ marginTop: 12 }}>
                  Đề xuất này đang chờ duyệt. <LumiLink href={`/lumi/approvals?tab=memory&id=${m.id}`}><u>Mở trong Chờ duyệt</u></LumiLink> để sửa và chọn phạm vi.
                </div>
              )}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
