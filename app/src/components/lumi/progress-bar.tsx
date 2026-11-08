"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/** "Tiến trình": where the workflow is, who has the ball (bot or you) and what to do next. Reads recorded facts only; no percentage is invented. */

import { useCallback, useEffect, useState } from "react";
import { Bot, CircleAlert, CircleCheck, UserRound } from "lucide-react";

import { fmtDuration, type Progress } from "@/lib/lumi/progress";
import { errText, lumiApi } from "@/lib/lumi/plans-client";
import { LumiLink } from "./ui";

const TONE_COLOR: Record<string, string> = { info: "var(--l-accent, #7c6cf0)", action: "#e0a33a", warn: "#e0a33a", error: "#d9534f", done: "#3aa76d" };
const WHO_LABEL: Record<string, string> = { BOT: "Bot đang làm — bạn chưa cần làm gì", OWNER: "Đến lượt bạn", NONE: "Không có việc cần làm" };

export function ProgressBar({ planId, goalCode }: { planId?: string; goalCode?: string }) {
  const [data, setData] = useState<{ items: Progress[]; offset: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    const r = await lumiApi<{ server_now: string; items: Progress[] }>("/api/v1/lumi/progress");
    if (r.ok && r.data) { setData({ items: r.data.items, offset: new Date(r.data.server_now).getTime() - Date.now() }); setErr(null); } else setErr(errText(r.error));
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 3000);
    const tick = setInterval(() => setTick((n) => n + 1), 1000); // only the elapsed clock moves between fetches
    return () => { clearInterval(t); clearInterval(tick); };
  }, [load]);

  if (err && !data) return <div className="l-note" role="alert" data-testid="progress-error">Không tải được tiến trình: {err}</div>;
  if (!data) return null;
  const items = data.items.filter((p) => (!planId || p.plan_id === planId) && (!goalCode || p.goal_code === goalCode));
  if (items.length === 0) return null;
  return (
    <div className="l-grid" style={{ gap: 10 }} data-testid="progress-bar">
      {items.map((p) => {
        const elapsed = p.run ? Math.max(0, Math.round((Date.now() + data.offset - new Date(p.run.since).getTime()) / 1000)) : null;
        const color = TONE_COLOR[p.tone] ?? TONE_COLOR.info;
        const Icon = p.tone === "error" || p.tone === "warn" ? CircleAlert : p.tone === "done" ? CircleCheck : p.who === "OWNER" ? UserRound : Bot;
        return (
          <section key={p.goal_code} className="l-card" style={{ borderLeft: `4px solid ${color}` }} data-testid={`progress-${p.goal_code}`} data-stage={p.stage} data-tone={p.tone}>
            <div className="l-row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 6 }} aria-label="Các bước">
              {p.steps.map((s, i) => (
                <span key={s.key} className="small" style={{ opacity: s.state === "todo" ? 0.45 : 1, fontWeight: s.state === "current" ? 700 : 400 }} data-state={s.state}>
                  {s.state === "done" ? "✓ " : s.state === "current" ? "● " : "○ "}{s.label}{i < p.steps.length - 1 ? "  ›" : ""}
                </span>
              ))}
            </div>
            <div className="l-row" style={{ gap: 8, alignItems: "flex-start" }}>
              <Icon size={18} color={color} style={{ flex: "none", marginTop: 2 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }} data-testid="progress-headline"><span className="muted">{p.goal_code}{p.plan_code ? ` · ${p.plan_code}` : ""}: </span>{p.headline}</div>
                <div className="small" style={{ marginTop: 2 }}>{p.detail}</div>
                {elapsed !== null && p.run && (
                  <div className="small" style={{ marginTop: 4 }} data-testid="progress-elapsed">
                    Đã chạy {fmtDuration(elapsed)}{p.run.limit_seconds ? ` / tối đa ${fmtDuration(p.run.limit_seconds)}` : ""}
                    {p.run.limit_seconds ? <progress value={Math.min(elapsed, p.run.limit_seconds)} max={p.run.limit_seconds} style={{ marginLeft: 8, verticalAlign: "middle", width: 120 }} aria-label="Thời gian đã chạy so với giới hạn" /> : null}
                  </div>
                )}
                {p.tasks && <div className="small muted" style={{ marginTop: 2 }}>Việc con: {p.tasks.done}/{p.tasks.total} xong</div>}
              </div>
            </div>
            <div className="l-row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap", justifyContent: "space-between" }}>
              <span className={`l-badge ${p.who === "OWNER" ? "amber" : ""}`} data-testid="progress-who">{WHO_LABEL[p.who]}</span>
              {p.next && (p.next.href
                ? <LumiLink href={p.next.href} className={`l-btn sm ${p.who === "OWNER" && p.tone !== "info" ? "primary" : ""}`} data-testid="progress-next">{p.next.label}</LumiLink>
                : <span className="small" data-testid="progress-next">{p.next.label}</span>)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
