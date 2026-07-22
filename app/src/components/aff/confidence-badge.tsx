import { AlertCircle, ShieldCheck, ShieldHalf } from "lucide-react";
import type { OfferConfidence } from "@/lib/db/schema/aff";
import { cn } from "@/lib/utils";

const CFG: Record<
  OfferConfidence,
  { label: string; icon: typeof ShieldCheck; className: string }
> = {
  VERIFIED: {
    label: "Verified",
    icon: ShieldCheck,
    className: "bg-primary/15 text-primary",
  },
  PARTIALLY_VERIFIED: {
    label: "Partially verified",
    icon: ShieldHalf,
    className: "bg-amber-500/15 text-amber-500",
  },
  UNVERIFIED: {
    label: "Unverified",
    icon: AlertCircle,
    className: "bg-muted-foreground/15 text-muted-foreground",
  },
};

export function ConfidenceBadge({ confidence, stale }: { confidence: OfferConfidence; stale?: boolean }) {
  const cfg = CFG[confidence];
  const Icon = cfg.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        cfg.className,
      )}
      aria-label={`Confidence: ${cfg.label}${stale ? " (dữ liệu quá 30 ngày)" : ""}`}
      title={stale ? "Dữ liệu chưa xác minh lại trong 30 ngày" : undefined}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {cfg.label}
      {stale ? <span className="opacity-70">· stale</span> : null}
    </span>
  );
}
