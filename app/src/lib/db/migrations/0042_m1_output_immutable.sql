-- M1: an approval binds to the exact bytes the owner saw (W-V2PRD P3-R07 AC-11 / P3-R04 spirit). Output content, version and owner task
-- can never change after insert; only the workflow columns (state, adoption) may. Additive: no data is rewritten.
CREATE OR REPLACE FUNCTION lumi_outputs_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.version IS DISTINCT FROM OLD.version OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN
    RAISE EXCEPTION 'lumi_task_outputs content/version/task/run/submitter are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_outputs_immutable_trg ON "lumi_task_outputs";--> statement-breakpoint
CREATE TRIGGER lumi_outputs_immutable_trg BEFORE UPDATE ON "lumi_task_outputs" FOR EACH ROW EXECUTE FUNCTION lumi_outputs_immutable();
