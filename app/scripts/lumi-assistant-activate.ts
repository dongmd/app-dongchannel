/**
 * Verifies a REAL Hermes profile against an assistant's allowlist and (with --apply) marks it VERIFIED and enables dispatch.
 * Why a script: the web app's "Giao việc: BẬT" runs its tool check through the Next process, which has no Docker access on the VPS;
 * this runs the SAME check (profile tools ⊆ allowlist, RESTRICTED mode) through the real adapter, on the host that can reach Hermes.
 *
 *   DATABASE_URL=… LUMI_HERMES_SSH_HOST=local tsx scripts/lumi-assistant-activate.ts --slug aff-trial            # read-only check
 *   DATABASE_URL=… LUMI_HERMES_SSH_HOST=local tsx scripts/lumi-assistant-activate.ts --slug aff-trial --apply    # VERIFIED + dispatch on
 *   …                                                                                    --slug aff-trial --disable  # dispatch off
 * It never calls a model. Every change is written to audit_events with actor `ops:imp01-trial`.
 */
import { connectLumi, postgresDb } from "../src/lib/lumi-m1/pg-adapter";
import { SshHermes } from "../src/lib/lumi-m1/ssh-hermes";
import { audit, missingExecConfig } from "../src/lib/lumi-m1/core";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const slug = arg("--slug");
const apply = process.argv.includes("--apply");
const disable = process.argv.includes("--disable");
if (!slug) { console.error("--slug is required"); process.exit(2); }

const sql = connectLumi(url, { max: 2 });
const db = postgresDb(sql);
const ACTOR = "ops:imp01-trial";

(async () => {
  const [a] = await db.query<any>(`SELECT * FROM lumi_assistants WHERE slug=$1`, [slug]);
  if (!a) { console.error(`assistant ${slug} not found`); process.exit(3); }
  console.log(`assistant ${a.slug} | profile=${a.hermes_profile} | mode=${a.capability_mode} | connection=${a.connection_state} | dispatch=${a.dispatch_enabled}`);
  if (disable) {
    await db.tx(async (t) => {
      await t.query(`UPDATE lumi_assistants SET dispatch_enabled=false WHERE id=$1`, [a.id]);
      await audit(t, "assistant.dispatch_enabled", ACTOR, { assistantId: a.id, enabled: false }, new Date());
    });
    console.log("dispatch DISABLED"); await sql.end(); return;
  }
  const missing = missingExecConfig(a);
  console.log("exec config missing:", missing.length ? missing.join(", ") : "(none)");
  if (a.capability_mode !== "RESTRICTED") { console.error(`REFUSED: capability_mode is ${a.capability_mode}; this script only activates RESTRICTED assistants`); process.exit(4); }
  const hermes = new SshHermes({ host: process.env.LUMI_HERMES_SSH_HOST ?? "local", profile: a.hermes_profile, maxTurns: 10, runDeadlineSeconds: 600 });
  const tools = await hermes.readProfileTools(a.hermes_profile);
  if (tools === null) { console.error("REFUSED: could not read the profile's tools from Hermes (nothing is enabled on an unknown profile)"); process.exit(5); }
  const extra = tools.filter((t) => !a.tool_allowlist.includes(t));
  const unused = (a.tool_allowlist as string[]).filter((t) => !tools.includes(t));
  console.log("profile tools (real, from Hermes):", tools.join(", "));
  console.log("allowlist                        :", (a.tool_allowlist as string[]).join(", "));
  console.log("exceeds allowlist:", extra.length ? extra.join(", ") : "(none)", "| allowed but not enabled in profile:", unused.length ? unused.join(", ") : "(none)");
  if (missing.length || extra.length || unused.includes("plan.submit.version") || unused.includes("outputs.submit") || unused.includes("knowledge.context")) {
    console.error("NOT READY: fix the items above (the run needs knowledge.context, outputs.submit and plan.submit.version in the profile)"); process.exit(6);
  }
  if (!apply) { console.log("CHECK OK (read-only). Re-run with --apply to mark VERIFIED and enable dispatch."); await sql.end(); return; }
  await db.tx(async (t) => {
    await t.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',connection_checked_at=now(),connection_error=NULL,dispatch_enabled=true WHERE id=$1`, [a.id]);
    await audit(t, "assistant.dispatch_enabled", ACTOR, { assistantId: a.id, enabled: true, verifiedBy: "real profile tools check", tools }, new Date());
  });
  console.log("APPLIED: connection VERIFIED, dispatch ENABLED"); await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
