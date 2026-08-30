import { listAgentRuns } from "@/lib/moneyos/queries";
import { RUN_STATE_LABELS, display, inStoredOrder, label } from "@/lib/moneyos/display-policy";
import { Badge, EmptyState, PageHeader, Table, Value } from "@/components/moneyos/primitives";

/**
 * P4-R11 AC-05 — agent runs.
 *
 * Shows what ran, against what, with what outcome, and WHY IT FAILED when it
 * did. A run surface that showed only a red badge would satisfy a loose reading
 * of the criterion and be useless at the exact moment someone needs it.
 *
 * Cost renders UNKNOWN when the provider did not report it. It is NOT 0 -- a
 * free run and an unreported one are different facts, and P4-R01 stores the
 * column nullable precisely so this surface can tell them apart.
 */
function tone(state: string) {
  if (state === "SUCCEEDED") return "good" as const;
  if (state === "FAILED") return "bad" as const;
  if (state === "REFUSED") return "warn" as const;
  return "neutral" as const;
}

export default async function AgentRunsPage() {
  const rows = inStoredOrder(await listAgentRuns());

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Lần chạy agent"
        description="Mọi lần agent chạy, kể cả lần bị framework từ chối trước khi bắt đầu."
        owner="agent_runs (P4-R01)"
      />

      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium">Agent framework: đã deploy, chưa kích hoạt.</p>
        <p className="mt-1 text-muted-foreground">
          Registry rỗng và <span className="font-mono text-xs">model_policies</span> chưa có
          dòng nào, nên chưa agent nào chạy được. Đây là trạng thái{" "}
          <span className="font-mono text-xs">STAGED</span> có chủ đích, không phải lỗi.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState reasonKey="agents" />
      ) : (
        <Table headers={["Agent", "Loại việc", "Thực thể", "Model", "Trạng thái", "Chi phí (USD)", "Lỗi"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-mono text-xs">{r.agentName}</td>
              <td className="px-3 py-2 font-mono text-xs">{r.taskClass}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {r.entityType}/{r.entityId}
              </td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.model)}</Value></td>
              <td className="px-3 py-2">
                <Badge tone={tone(r.state)}>{label(RUN_STATE_LABELS, r.state)}</Badge>
              </td>
              <td className="px-3 py-2 font-mono text-xs tabular-nums">
                <Value>{display(r.costUsd)}</Value>
              </td>
              <td className="px-3 py-2 text-xs">
                {r.errorCode === null ? (
                  <span className="text-muted-foreground/50">—</span>
                ) : (
                  <span>
                    <span className="font-mono text-red-600 dark:text-red-400">{r.errorCode}</span>
                    {r.errorMessage && (
                      <span className="ml-2 text-muted-foreground">{r.errorMessage}</span>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
