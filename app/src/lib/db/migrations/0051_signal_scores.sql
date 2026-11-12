-- Đợt 7 (MOS-05): điểm cơ hội có phiên bản, lưu RIÊNG khỏi tín hiệu (thiết kế cũ đã bỏ điểm khỏi opportunity_signals: tín hiệu không phải phán đoán).
-- Chỉ THÊM bảng mới, chỉ-thêm: mỗi lần chấm là một dòng; điểm hiện hành = dòng mới nhất.
CREATE TABLE IF NOT EXISTS "lumi_signal_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "signal_id" uuid NOT NULL REFERENCES "opportunity_signals"("id") ON DELETE CASCADE,
  "config_version" text NOT NULL,
  "score" numeric NOT NULL CHECK ("score" >= 0 AND "score" <= 100),
  "breakdown" jsonb NOT NULL,
  "scored_by" text NOT NULL,
  "scored_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_signal_scores_idx" ON "lumi_signal_scores" ("signal_id","scored_at" DESC);--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_signal_scores_append_only_trg ON "lumi_signal_scores";--> statement-breakpoint
CREATE TRIGGER lumi_signal_scores_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_signal_scores" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();
