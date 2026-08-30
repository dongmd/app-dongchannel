import { listOpportunities } from "@/lib/moneyos/queries";
import {
  OPPORTUNITY_STATUS_LABELS, display, displayCoverage, displayScore,
  inStoredOrder, isThinlyAssessed, label,
} from "@/lib/moneyos/display-policy";
import { Badge, EmptyState, PageHeader, Table, Value } from "@/components/moneyos/primitives";

/**
 * P4-R11 — the opportunity queue.
 *
 * AC-02: the order comes from `queries.ts` and is passed through untouched.
 * AC-04: an unscored opportunity shows UNKNOWN, never 0 — and the coverage
 * column exists because 82-over-3-dimensions and 82-over-11 are different facts
 * that P2-R03 deliberately stored separately.
 */
export default async function OpportunitiesPage() {
  const rows = inStoredOrder(await listOpportunities());

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Cơ hội nội dung"
        description="Xếp theo điểm chuẩn hoá P2-R03 đã lưu, giảm dần. Cơ hội chưa chấm điểm nằm cuối — chưa chấm không phải là điểm thấp."
        owner="content_opportunities + content_opportunity_scores (P2)"
      />

      {rows.length === 0 ? (
        <EmptyState reasonKey="opportunities" />
      ) : (
        <Table headers={["Tiêu đề", "Chế độ", "Trạng thái", "Điểm", "Đã đánh giá", "Phiên bản chấm"]}>
          {rows.map((r) => {
            const thin = isThinlyAssessed(r.knownDimensions, r.totalDimensions);
            return (
              <tr key={r.id}>
                <td className="px-3 py-2">{r.title}</td>
                <td className="px-3 py-2"><Value>{display(r.contentMode)}</Value></td>
                <td className="px-3 py-2">
                  <Badge>{label(OPPORTUNITY_STATUS_LABELS, r.status)}</Badge>
                </td>
                <td className="px-3 py-2 font-mono tabular-nums">
                  <Value>{displayScore(r.normalisedScore)}</Value>
                </td>
                <td className="px-3 py-2">
                  <span className="font-mono text-xs">
                    <Value>{displayCoverage(r.knownDimensions, r.totalDimensions)}</Value>
                  </span>
                  {thin === true && <span className="ml-2"><Badge tone="warn">đánh giá mỏng</Badge></span>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  <Value>{display(r.scoringConfigVersion)}</Value>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}
