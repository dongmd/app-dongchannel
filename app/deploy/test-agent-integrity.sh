#!/usr/bin/env bash
# P4-R01 — do the agent framework's database invariants hold in PRODUCTION?
#
# `agent-policy.test.ts` proves `buildRunRecord` refuses a run that records a
# lie. That protects the one path that goes through it. This asks the different
# and harder question: does the DATABASE refuse the same rows, for the
# hand-written INSERT during an incident that never touches the policy module?
#
# ## Non-destructive by construction
#
# Every case runs inside BEGIN ... ROLLBACK. Nothing is committed, no sequence
# is consumed that matters, and the tables are left exactly as found. The
# owner's constraint on production negative testing is met by the transaction,
# not by being careful.
#
# ## Every group carries a CONTROL
#
# A constraint that refuses everything passes every negative case and is worse
# than no constraint at all. So each group also inserts the row that SHOULD be
# accepted, and the run is void unless those succeed.
#
# Exit 0 = every invariant refused what it must and accepted what it must.
# Exit 1 = an invariant is missing, or the harness could not measure.

set -uo pipefail

PSQL="${PSQL:-sudo -u postgres psql -tAq -d dongchannel_ops}"

pass=0; fail=0; control_failed=0

# $1 label   $2 expect: REFUSE|ACCEPT   $3 SQL
probe() {
  local label="$1" expect="$2" sql="$3" out rc
  out="$($PSQL -v ON_ERROR_STOP=1 <<SQL 2>&1
BEGIN;
$sql
ROLLBACK;
SQL
)"
  rc=$?

  if [ "$expect" = "REFUSE" ]; then
    if [ $rc -ne 0 ]; then
      echo "  ✓ refused: $label"; pass=$((pass+1))
    else
      echo "  ✗ ACCEPTED a row it must refuse: $label"; fail=$((fail+1))
    fi
  else
    if [ $rc -eq 0 ]; then
      echo "  ✓ accepted: $label"; pass=$((pass+1))
    else
      echo "  ✗ CONTROL FAILED -- refused a row it must accept: $label"
      echo "    $out" | head -3
      control_failed=$((control_failed+1))
    fi
  fi
}

RUN_COLS="agent_name,profile,task_class,entity_type,entity_id,state,started_at,finished_at,error_code"

echo "== the tables exist at all =="
n=$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('agent_runs','model_policies');" | tr -d ' ')
if [ "$n" != "2" ]; then
  echo "FAIL: expected 2 tables, found $n -- the harness is measuring nothing"
  exit 1
fi
echo "  ✓ agent_runs and model_policies present"

echo
echo "== AC-06: FAILED, NEVER-STARTED and IN-FLIGHT stay distinguishable =="

probe "PENDING carrying a start time" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','PENDING',now(),NULL,NULL);"

probe "REFUSED carrying a finish time" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','REFUSED',NULL,now(),'E');"

probe "RUNNING with no start time" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','RUNNING',NULL,NULL,NULL);"

probe "RUNNING that has already finished" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','RUNNING',now(),now(),NULL);"

probe "SUCCEEDED with no finish time" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','SUCCEEDED',now(),NULL,NULL);"

probe "a run that finished before it started" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','SUCCEEDED',now(),now() - interval '1 hour',NULL);"

# CONTROL: the three states must each be insertable in their honest form.
probe "CONTROL a PENDING run with no times" ACCEPT "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','PENDING',NULL,NULL,NULL);"

probe "CONTROL a RUNNING run with a start only" ACCEPT "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','RUNNING',now(),NULL,NULL);"

probe "CONTROL a SUCCEEDED run with both times" ACCEPT "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','SUCCEEDED',now() - interval '5 sec',now(),NULL);"

echo
echo "== AC-06: a failure that cannot say why is not a record =="

probe "FAILED with no error code" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','FAILED',now() - interval '5 sec',now(),NULL);"

probe "REFUSED with no error code" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','REFUSED',NULL,NULL,NULL);"

probe "SUCCEEDED carrying an error code" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','SUCCEEDED',now() - interval '5 sec',now(),'BOOM');"

probe "CONTROL a FAILED run that says why" ACCEPT "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','FAILED',now() - interval '5 sec',now(),'PROVIDER_ERROR');"

echo
echo "== AC-05: an unreported cost is NULL, and a negative one is not a fact =="

probe "a negative cost" REFUSE "
INSERT INTO agent_runs ($RUN_COLS,cost_usd) VALUES
('a','aff','RESEARCH','opportunity','x','SUCCEEDED',now() - interval '5 sec',now(),NULL,-0.01);"

probe "a negative token count" REFUSE "
INSERT INTO agent_runs ($RUN_COLS,prompt_tokens) VALUES
('a','aff','RESEARCH','opportunity','x','SUCCEEDED',now() - interval '5 sec',now(),NULL,-1);"

# The distinction AC-05 exists for: NULL is permitted, and it is not 0.
probe "CONTROL an unreported cost as NULL" ACCEPT "
INSERT INTO agent_runs ($RUN_COLS,cost_usd,prompt_tokens) VALUES
('a','aff','RESEARCH','opportunity','x','SUCCEEDED',now() - interval '5 sec',now(),NULL,NULL,NULL);"

probe "CONTROL a genuinely zero cost" ACCEPT "
INSERT INTO agent_runs ($RUN_COLS,cost_usd) VALUES
('a','aff','RESEARCH','opportunity','x','SUCCEEDED',now() - interval '5 sec',now(),NULL,0);"

echo
echo "== AC-08: at most one active model policy per task class =="

probe "a second ACTIVE policy for the same task class" REFUSE "
INSERT INTO model_policies (task_class,provider,model,active) VALUES
('RESEARCH','anthropic','claude-opus-5','true'),
('RESEARCH','anthropic','claude-sonnet-5','true');"

probe "CONTROL one active plus one INACTIVE for the same class" ACCEPT "
INSERT INTO model_policies (task_class,provider,model,active) VALUES
('RESEARCH','anthropic','claude-opus-5','true'),
('RESEARCH','anthropic','claude-sonnet-5','false');"

probe "CONTROL one active policy per class, across two classes" ACCEPT "
INSERT INTO model_policies (task_class,provider,model,active) VALUES
('RESEARCH','anthropic','claude-opus-5','true'),
('WRITING','anthropic','claude-opus-5','true');"

probe "an active flag that is neither true nor false" REFUSE "
INSERT INTO model_policies (task_class,provider,model,active) VALUES
('QA','anthropic','claude-opus-5','maybe');"

echo
echo "== the enum vocabularies are closed =="

probe "a state outside agent_run_state" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','RESEARCH','opportunity','x','ALMOST_DONE',NULL,NULL,NULL);"

probe "a task class outside agent_task_class" REFUSE "
INSERT INTO agent_runs ($RUN_COLS) VALUES
('a','aff','TAROT','opportunity','x','PENDING',NULL,NULL,NULL);"

echo
echo "== nothing was committed =="
left=$($PSQL -c "SELECT count(*) FROM agent_runs;" | tr -d ' ')
pol=$($PSQL -c "SELECT count(*) FROM model_policies;" | tr -d ' ')
echo "  agent_runs rows: $left   model_policies rows: $pol"
if [ "$left" != "0" ] || [ "$pol" != "0" ]; then
  echo "  ✗ the harness left rows behind -- every probe should have rolled back"
  fail=$((fail+1))
else
  echo "  ✓ both tables are as they were found"
fi

echo
echo "==================================="
echo "pass=$pass  fail=$fail  control_failed=$control_failed"
if [ "$control_failed" -gt 0 ]; then
  echo "VOID: a CONTROL failed. A constraint that refuses everything proves nothing,"
  echo "      so the refusals above cannot be counted as evidence."
  exit 1
fi
if [ "$fail" -gt 0 ]; then
  echo "FAIL: an invariant did not hold in production."
  exit 1
fi
echo "PASS: every invariant refused what it must and accepted what it must."
