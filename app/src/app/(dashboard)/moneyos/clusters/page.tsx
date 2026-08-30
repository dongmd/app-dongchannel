import { listClusters } from "@/lib/moneyos/queries";
import { display, inStoredOrder } from "@/lib/moneyos/display-policy";
import { Badge, EmptyState, PageHeader, Table, Value } from "@/components/moneyos/primitives";

export default async function ClustersPage() {
  const rows = inStoredOrder(await listClusters());
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Cụm chủ đề"
        description="TopicCluster — nhóm chủ đề dùng để xây thẩm quyền nội dung và chiếu sang taxonomy WordPress."
        owner="topic_clusters (P2-R04)"
      />
      {rows.length === 0 ? <EmptyState reasonKey="clusters" /> : (
        <Table headers={["Khoá", "Tiêu đề", "Trạng thái", "Profile"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-mono text-xs">{r.key}</td>
              <td className="px-3 py-2"><Value>{display(r.title)}</Value></td>
              <td className="px-3 py-2"><Badge>{display(r.state)}</Badge></td>
              <td className="px-3 py-2 font-mono text-xs"><Value>{display(r.profileSlug)}</Value></td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
