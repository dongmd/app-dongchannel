import { ExternalLink } from "lucide-react";
import { HermesHealthBadge } from "@/components/admin/hermes-health-badge";
import { pingHermesStatus } from "@/lib/hermes/status";
import { requireRoleOrRedirect } from "@/lib/authz";

// AC02 — 5 nhóm theo PRD FR-08.
interface AdminGroup {
  title: string;
  description: string;
  tools: string[];
}
const ADMIN_GROUPS: AdminGroup[] = [
  {
    title: "Agents",
    description: "Profile, model, skill, plugin, MCP — cấu hình bot",
    tools: ["Profiles", "Models", "Skills", "Plugins", "MCP"],
  },
  {
    title: "Integrations",
    description: "Kênh giao tiếp — hiện đang dùng 2 Telegram bot (AFF + YouTube)",
    tools: ["Channels", "Webhooks", "Pairing"],
  },
  {
    title: "Automation",
    description: "Cron job chạy nền",
    tools: ["Cron"],
  },
  {
    title: "Data & Diagnostics",
    description: "Session thô, file upload, log — chỉ tra cứu khi có sự cố",
    tools: ["Raw Sessions", "Files", "Logs"],
  },
  {
    title: "Security & Settings",
    description: "Config, API key, system status — quyền ADMIN",
    tools: ["Config", "Keys", "System"],
  },
];

export default async function AdminIndex() {
  // AC01 — chỉ OWNER/ADMIN
  await requireRoleOrRedirect(["OWNER", "ADMIN"]);
  const status = await pingHermesStatus();

  const hermesDashboardUrl =
    process.env.NEXT_PUBLIC_HERMES_DASHBOARD_URL ?? "https://hermes.dongchannel.com";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Quản trị hệ thống</h1>
        <p className="text-sm text-muted-foreground">
          Các công cụ kỹ thuật Hermes vẫn ở dashboard gốc. Trang này là bản đồ dẫn tới đó và trạng
          thái kết nối.
        </p>
      </header>

      <HermesHealthBadge initial={status} />

      <div className="flex flex-wrap gap-3">
        <a
          href={hermesDashboardUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Mở Hermes Dashboard (${hermesDashboardUrl})`}
          className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-4 py-2 text-sm text-primary hover:bg-primary/20 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Mở Hermes Dashboard
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
        <span className="self-center font-mono text-xs text-muted-foreground">
          {hermesDashboardUrl}
        </span>
      </div>

      <section aria-labelledby="admin-groups-heading" className="space-y-3">
        <h2 id="admin-groups-heading" className="text-sm font-medium text-muted-foreground">
          Chức năng theo nhóm
        </h2>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {ADMIN_GROUPS.map((group) => (
            <li
              key={group.title}
              className="rounded-lg border border-border bg-muted/10 p-4"
            >
              <h3 className="text-sm font-semibold">{group.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{group.description}</p>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {group.tools.map((tool) => (
                  <li
                    key={tool}
                    className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {tool}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-muted-foreground">
        URL dashboard Hermes cấu hình qua{" "}
        <code className="font-mono">NEXT_PUBLIC_HERMES_DASHBOARD_URL</code>. Health check hit{" "}
        <code className="font-mono">HERMES_API_BASE_URL/api/status</code> (public, cache 30s).
      </p>
    </div>
  );
}
