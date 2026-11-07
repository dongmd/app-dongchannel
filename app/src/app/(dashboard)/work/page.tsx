/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL read models (core-web.ts), typed at the boundary in TDD 14.9 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, lumiDb, lumiHermes } from "@/lib/lumi-m1/server";
import { listTasks, lumiOverview } from "@/lib/lumi-m1/core-web";
import { listOpenDrafts } from "@/lib/lumi-m1/core";
import { DraftList } from "@/components/work/draft-list";
import { hermesModeLabel } from "@/lib/lumi-m1/hermes-port";
import { WorkStatusBadge } from "@/components/work/work-status";
import { CreateTaskForm } from "@/components/work/create-task-form";
import { AssistantPanel } from "@/components/work/assistant-panel";

export const dynamic = "force-dynamic";

export default async function WorkPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const db = lumiDb();
  const [tasks, ov, drafts] = await Promise.all([listTasks(db, 100), lumiOverview(db), listOpenDrafts(db, new Date())]);
  const flag = (k: string) => ov.flags.find((f: any) => f.key === k)?.value === true;
  const m1 = flag("m1_enabled");
  const canCreate = user.role !== "VIEWER" && m1;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">Giao việc (Dong-Lumi M1)</h1>
        <p className="text-sm text-muted-foreground">
          Dữ liệu thật trong PostgreSQL của môi trường này. Bạn đăng nhập: {user.email} ({user.role}).
        </p>
        <p role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          Ranh giới Hermes/Telegram: {hermesModeLabel(lumiHermes())}. {(lumiHermes() as { simulated?: boolean }).simulated ? "Việc giao ở đây được lưu thật; phản hồi của trợ lý chỉ là mô phỏng cho tới khi có kiểm chứng tích hợp thật." : "Chế độ thử nghiệm: chỉ profile Hermes thử `lumitest` qua SSH (không phải bot production); dữ liệu việc là tổng hợp."}
        </p>
        {!m1 && (
          <p role="alert" className="rounded-md border border-border px-3 py-2 text-xs">
            Luồng M1 đang TẮT (cờ m1_enabled): không tạo/giao việc mới. OWNER có thể bật ở khung Trợ lý và công tắc.
          </p>
        )}
        {flag("emergency_stop") && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            DỪNG KHẨN CẤP đang bật: không gửi lệnh nào cho trợ lý.
          </p>
        )}
      </header>

      {canCreate && drafts.length > 0 ? <DraftList drafts={drafts.map((d: any) => ({ id: d.id, raw_text: d.raw_text, missing: d.missing, expires_at: String(d.expires_at), actor_ref: d.actor_ref, assistant_name: d.assistant_name }))} /> : null}
      {canCreate ? <CreateTaskForm projects={ov.projects} assistants={ov.assistants} /> : null}
      <AssistantPanel assistants={ov.assistants} role={user.role} emergencyStop={flag("emergency_stop")} m1Enabled={m1} />

      <section aria-label="Danh sách việc" className="space-y-2">
        <h2 className="text-sm font-semibold">Việc ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Chưa có việc M1 nào.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-muted/5">
            {tasks.map((t: any) => (
              <li key={t.id}>
                <Link href={`/work/${t.id}`} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring">
                  <span className="w-16 font-mono text-xs text-muted-foreground">{t.code}</span>
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {t.project_name} · {t.owner_name}
                  </span>
                  {t.needs_decision && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-500">Cần quyết định</span>}
                  <WorkStatusBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
