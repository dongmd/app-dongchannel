import { listCandidates } from "@/lib/moneyos/queries";
import { display, inStoredOrder } from "@/lib/moneyos/display-policy";
import { Badge, EmptyState, PageHeader, Table, Value } from "@/components/moneyos/primitives";

/**
 * Bidirectional Discovery: researching a trend or tool can surface an affiliate
 * programme worth pursuing. `programmeExists` is deliberately three-valued --
 * true, false, and NOT YET KNOWN -- so "we have not checked" never renders as
 * "there is no programme".
 */
export default async function CandidatesPage() {
  const rows = inStoredOrder(await listCandidates());
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Ứng viên affiliate"
        description="Bidirectional Discovery — nội dung tìm ra chương trình affiliate, không chỉ chiều ngược lại."
        owner="affiliate_project_candidates (P2-R06)"
      />
      {rows.length === 0 ? <EmptyState reasonKey="candidates" /> : (
        <Table headers={["Nhà cung cấp", "Khoá", "Có chương trình?", "Trạng thái", "Lý do"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-medium"><Value>{display(r.vendorName)}</Value></td>
              <td className="px-3 py-2 font-mono text-xs">{r.candidateKey}</td>
              <td className="px-3 py-2">
                {r.programmeExists === null ? (
                  <Badge>chưa kiểm chứng</Badge>
                ) : (
                  <Badge tone={r.programmeExists ? "good" : "neutral"}>
                    {r.programmeExists ? "Có" : "Không"}
                  </Badge>
                )}
              </td>
              <td className="px-3 py-2"><Badge>{display(r.status)}</Badge></td>
              <td className="px-3 py-2 text-muted-foreground"><Value>{display(r.statusReason)}</Value></td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
