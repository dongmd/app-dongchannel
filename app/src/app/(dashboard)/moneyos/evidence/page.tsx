import { listClaims, listEvidence } from "@/lib/moneyos/queries";
import { display, inStoredOrder } from "@/lib/moneyos/display-policy";
import { Badge, EmptyState, PageHeader, Table, Value } from "@/components/moneyos/primitives";

/**
 * Evidence and claims, on one page because a claim without its evidence is the
 * thing this project exists not to publish.
 *
 * `verificationStatus` is rendered as stored. The UI does NOT decide whether a
 * claim is verified -- that is set from evidence and QA, never from a surface,
 * and never from an owner approval.
 */
export default async function EvidencePage() {
  const [ev, cl] = await Promise.all([listEvidence(), listClaims()]);
  const evidence = inStoredOrder(ev);
  const claims = inStoredOrder(cl);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        title="Bằng chứng & Claim"
        description="Nguồn đã thu thập và các khẳng định rút ra từ chúng. Trạng thái xác minh đọc từ dữ liệu — giao diện không tự quyết."
        owner="evidence + claims (P2-R07)"
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Bằng chứng</h2>
        {evidence.length === 0 ? <EmptyState reasonKey="evidence" /> : (
          <Table headers={["Tiêu đề", "Nhà xuất bản", "Thực thể", "Độ tin cậy", "Trạng thái"]}>
            {evidence.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2"><Value>{display(r.title)}</Value></td>
                <td className="px-3 py-2"><Value>{display(r.publisher)}</Value></td>
                <td className="px-3 py-2 font-mono text-xs">{r.entityType}</td>
                <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.confidence)}</Value></td>
                <td className="px-3 py-2"><Badge>{display(r.status)}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Claim</h2>
        {claims.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-sm text-muted-foreground">
            Chưa có claim nào. Claim được tạo cùng bằng chứng chống lưng cho nó.
          </div>
        ) : (
          <Table headers={["Khoá", "Nội dung", "Thực thể", "Xác minh"]}>
            {claims.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 font-mono text-xs">{r.claimKey}</td>
                <td className="px-3 py-2"><Value>{display(r.claimText)}</Value></td>
                <td className="px-3 py-2 font-mono text-xs">{r.entityType}</td>
                <td className="px-3 py-2"><Badge>{display(r.verificationStatus)}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
