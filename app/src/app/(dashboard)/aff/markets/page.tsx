import { AffTabs } from "@/components/aff/aff-tabs";
import { listMarkets } from "@/lib/moneyos/queries";
import { display, inStoredOrder } from "@/lib/moneyos/display-policy";
import { Badge, Table, Value } from "@/components/moneyos/primitives";

/**
 * P4-R11 AC-07 — the DC-011b promise, delivered.
 *
 * This page used to say "Markets UI chưa xây … Sẽ có ở follow-up story
 * DC-011b" — a commitment made to a user in production, naming a story id that
 * existed in no register. That was the defect the whole DC-011B record is about.
 *
 * It is delivered READ-ONLY, deliberately. `markets` is a real table and it is
 * empty; an editor for a table nothing writes to would be UI ahead of a
 * capability. The four scores are nullable, so they render UNKNOWN rather than
 * 0 — a market nobody has scored is not a market that scored zero.
 */
export default async function AffMarketsPage() {
  const rows = inStoredOrder(await listMarkets());

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">AFF · Markets</h1>
        <p className="text-sm text-muted-foreground">
          Thị trường (health/pet/finance/…) dùng để gán cho offer. Danh sách chỉ đọc.
        </p>
      </header>
      <AffTabs />

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <p className="text-sm font-medium">Chưa có thị trường nào được tạo.</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Bảng <span className="font-mono text-xs">markets</span> đã có sẵn và đang trống.
            Trong lúc chờ, gán market cho offer qua field{" "}
            <span className="font-mono text-xs">market_id</span>.
          </p>
          <p className="mt-4 text-xs text-muted-foreground/70">Bảng trống thật, không phải lỗi tải.</p>
        </div>
      ) : (
        <Table headers={["Tên", "Mô tả", "Nhu cầu", "Bền vững", "Cạnh tranh", "Rủi ro chính sách", "Trạng thái"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-medium">{r.name}</td>
              <td className="px-3 py-2 text-muted-foreground"><Value>{display(r.summary)}</Value></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.demandScore)}</Value></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.longevityScore)}</Value></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.competitionScore)}</Value></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.policyRiskScore)}</Value></td>
              <td className="px-3 py-2"><Badge>{r.status}</Badge></td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
