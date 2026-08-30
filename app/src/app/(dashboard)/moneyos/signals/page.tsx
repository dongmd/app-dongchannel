import { listSignals } from "@/lib/moneyos/queries";
import { SIGNAL_STATUS_LABELS, display, inStoredOrder, label } from "@/lib/moneyos/display-policy";
import { Badge, EmptyState, PageHeader, Table, Value } from "@/components/moneyos/primitives";

export default async function SignalsPage() {
  const rows = inStoredOrder(await listSignals());
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Tín hiệu cơ hội"
        description="OpportunitySignal — tín hiệu thô từ nguồn, hoặc ý tưởng owner nhập qua Telegram."
        owner="opportunity_signals (P2-R01)"
      />
      {rows.length === 0 ? <EmptyState reasonKey="signals" /> : (
        <Table headers={["Tiêu đề", "Loại", "Nguồn gốc", "Trạng thái", "Độ tin cậy", "Ngôn ngữ"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2"><Value>{display(r.title)}</Value></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.kind)}</Value></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.originMode)}</Value></td>
              <td className="px-3 py-2"><Badge>{label(SIGNAL_STATUS_LABELS, r.status)}</Badge></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.confidence)}</Value></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.language)}</Value></td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
