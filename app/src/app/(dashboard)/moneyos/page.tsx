import { surfaceCounts } from "@/lib/moneyos/queries";
import { PageHeader, SurfaceCard } from "@/components/moneyos/primitives";

/**
 * P4-R11 — the AI Money OS index.
 *
 * P2 shipped eleven live tables with no interface at all. This is the door to
 * them. Every count is a real `count(*)`; a hard-coded 0 would look identical
 * today and would still say 0 on the day it mattered, which is the DC-011/012
 * defect already on this project's record.
 */

const SURFACES = [
  { key: "opportunities", href: "/moneyos/opportunities" as const, title: "Cơ hội nội dung", description: "Hàng đợi cơ hội, xếp theo điểm P2-R03 đã lưu" },
  { key: "signals", href: "/moneyos/signals" as const, title: "Tín hiệu", description: "OpportunitySignal từ nguồn và từ owner" },
  { key: "clusters", href: "/moneyos/clusters" as const, title: "Cụm chủ đề", description: "TopicCluster và trạng thái chiếu sang WordPress" },
  { key: "trends", href: "/moneyos/trends" as const, title: "Trend Radar", description: "Allowlist chủ đề trend được phép theo dõi" },
  { key: "candidates", href: "/moneyos/candidates" as const, title: "Ứng viên affiliate", description: "Bidirectional Discovery — nội dung tìm ra chương trình" },
  { key: "evidence", href: "/moneyos/evidence" as const, title: "Bằng chứng", description: "Evidence và claim, kèm nguồn và độ tươi" },
  { key: "agents", href: "/moneyos/agents" as const, title: "Lần chạy agent", description: "agent_runs — cái gì chạy, kết quả, và vì sao hỏng" },
];

export default async function MoneyOsPage() {
  const counts = await surfaceCounts();
  const byKey = new Map(counts.map((c) => [c.key, c.count]));
  const total = counts.reduce((s, c) => s + c.count, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="AI Money OS"
        description="Các bề mặt vận hành của Opportunity Engine. Chỉ đọc và chiếu — không tính điểm, không xếp hạng lại."
      />

      {total === 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Toàn bộ bảng đang trống.</p>
          <p className="mt-1 text-muted-foreground">
            Đây là sự thật về pipeline, không phải lỗi giao diện. Mô hình dữ liệu P2 đã có
            trên production; chưa có agent nào chạy để sinh dữ liệu. Bề mặt đã sẵn sàng và
            sẽ hiển thị ngay khi có dòng đầu tiên.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {SURFACES.map((s) => (
          <SurfaceCard
            key={s.key}
            href={s.href}
            title={s.title}
            description={s.description}
            count={byKey.get(s.key) ?? 0}
          />
        ))}
      </div>
    </div>
  );
}
