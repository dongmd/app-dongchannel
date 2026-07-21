import { ExternalLink } from "lucide-react";

export default function AdminIndex() {
  const hermesDashboardUrl =
    process.env.NEXT_PUBLIC_HERMES_DASHBOARD_URL ?? "https://hermes.dongchannel.com";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Quản trị hệ thống</h1>
        <p className="text-sm text-muted-foreground">
          Các công cụ kỹ thuật Hermes (sessions thô, models, logs, cron, skills, plugins, MCP,
          channels, webhooks, pairing, profiles, config, keys, system) sống ở dashboard Hermes gốc.
        </p>
      </header>

      <a
        href={hermesDashboardUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Mở Hermes Dashboard
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
      </a>

      <p className="text-xs text-muted-foreground">
        URL cấu hình qua biến <code className="font-mono">NEXT_PUBLIC_HERMES_DASHBOARD_URL</code>.
      </p>
    </div>
  );
}
