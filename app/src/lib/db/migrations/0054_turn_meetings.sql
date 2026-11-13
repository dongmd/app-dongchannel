-- Đợt 8 (nhóm 3): họp theo lượt (MTG-04). Chỉ THÊM bảng mới. Mỗi lượt phát biểu là một việc/lượt chạy của bot; dừng khi chạm số lượt, trần chi phí ĐO THẬT, hạn giờ, hoặc một vòng không có lập trường mới.
CREATE SEQUENCE IF NOT EXISTS "lumi_tm_seq";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_turn_meetings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE DEFAULT ('TM-' || lpad(nextval('lumi_tm_seq')::text, 3, '0')),
  "title" text NOT NULL CHECK (length("title") BETWEEN 3 AND 200),
  "question" text NOT NULL CHECK (length("question") BETWEEN 3 AND 4000),
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "speakers" uuid[] NOT NULL,
  "max_turns" integer NOT NULL CHECK ("max_turns" BETWEEN 2 AND 30),
  "max_cost" numeric CHECK ("max_cost" IS NULL OR "max_cost" >= 0),
  "currency" text NOT NULL DEFAULT 'USD' CHECK ("currency" = 'USD'),
  "closes_at" timestamptz NOT NULL,
  "state" text NOT NULL DEFAULT 'OPEN' CHECK ("state" IN ('OPEN','CLOSED')),
  "outcome" text CHECK ("outcome" IS NULL OR "outcome" IN ('CONCLUDED','NOT_CONCLUDED')),
  "stop_reason" text CHECK ("stop_reason" IS NULL OR "stop_reason" IN ('AGREED','MAX_TURNS','COST','TIME','NO_NEW_POSITION','MANUAL')),
  "summary" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  CONSTRAINT "lumi_tm_closed_chk" CHECK (("state" = 'CLOSED') = ("outcome" IS NOT NULL))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_turn_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "meeting_id" uuid NOT NULL REFERENCES "lumi_turn_meetings"("id"),
  "turn_no" integer NOT NULL CHECK ("turn_no" >= 1),
  "assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "task_id" uuid REFERENCES "tasks"("id"),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','DONE','SKIPPED')),
  "stance" text CHECK ("stance" IS NULL OR length("stance") BETWEEN 3 AND 4000),
  "new_position" boolean,
  "agrees" boolean,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "done_at" timestamptz,
  CONSTRAINT "lumi_turn_entries_uq" UNIQUE ("meeting_id","turn_no"),
  CONSTRAINT "lumi_turn_entries_done_chk" CHECK ("state" <> 'DONE' OR ("stance" IS NOT NULL AND "new_position" IS NOT NULL AND "agrees" IS NOT NULL))
);
