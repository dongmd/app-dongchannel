import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { getProfileFilter } from "@/lib/profiles/server";
import { PROFILE_LABELS } from "@/lib/profiles/types";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OverviewPage({ searchParams }: Props) {
  const [session, profile] = await Promise.all([
    getServerSession(authOptions),
    getProfileFilter(searchParams),
  ]);
  const profileLabel = PROFILE_LABELS[profile];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Tổng quan</h1>
          <p className="text-sm text-muted-foreground">
            Daily command center — sẽ có KPI, decision inbox, active tasks, next best actions ở
            DC-005.
          </p>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground"
          title={`Đang lọc theo ${profileLabel.long}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Profile: <strong className="text-foreground">{profileLabel.short}</strong>
        </span>
      </header>

      {session?.user ? (
        <section className="rounded-lg border border-primary/40 bg-primary/5 p-4 text-sm">
          Đăng nhập: <strong>{session.user.email}</strong> · Role{" "}
          <strong>{session.user.role}</strong>
        </section>
      ) : null}

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {["Chờ duyệt", "Đang chạy", "Cảnh báo", "Test đang active"].map((label) => (
          <div
            key={label}
            className="rounded-lg border border-border bg-muted/10 p-4"
            aria-label={`KPI ${label}`}
          >
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-semibold text-muted-foreground/50">—</div>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Chưa có dữ liệu. Sau khi cắm Hermes (DC-006), việc cần xử lý sẽ hiện ở đây trong 5 giây.
      </section>
    </div>
  );
}
