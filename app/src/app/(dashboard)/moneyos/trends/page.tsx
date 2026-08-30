import { listTrends } from "@/lib/moneyos/queries";
import { display, inStoredOrder } from "@/lib/moneyos/display-policy";
import { Badge, EmptyState, PageHeader, Table, Value } from "@/components/moneyos/primitives";

export default async function TrendsPage() {
  const rows = inStoredOrder(await listTrends());
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Trend Radar"
        description="Allowlist chủ đề trend được phép theo dõi. Nội dung trend chỉ nằm trong phạm vi đã duyệt."
        owner="trend_allowlist (P2-R05)"
      />
      {rows.length === 0 ? <EmptyState reasonKey="trends" /> : (
        <Table headers={["Từ khoá", "Bật", "Lý do", "Thêm bởi"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-medium">{r.term}</td>
              <td className="px-3 py-2">
                <Badge tone={r.enabled ? "good" : "neutral"}>{r.enabled ? "Bật" : "Tắt"}</Badge>
              </td>
              <td className="px-3 py-2 text-muted-foreground"><Value>{display(r.rationale)}</Value></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.addedBy)}</Value></td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
