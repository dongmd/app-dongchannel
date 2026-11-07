-- M1 (TDD 6.5 l): additive enum values. Not used in this migration (PostgreSQL rule); used from 0040 onwards.
ALTER TYPE "task_status" ADD VALUE IF NOT EXISTS 'WAITING_ASSISTANT';--> statement-breakpoint
ALTER TYPE "task_status" ADD VALUE IF NOT EXISTS 'ON_HOLD';
