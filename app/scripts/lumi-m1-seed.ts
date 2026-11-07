/**
 * Dev/test seed for the M1 test environment. Idempotent. Applies any pending real migrations (tracked in
 * lumi_dev_migrations — a throwaway table used ONLY by this dev script; production uses drizzle-kit) and inserts SYNTHETIC data:
 * three people (OWNER/ADMIN/VIEWER on the allowlist), one project, one verified assistant `lumitest` with a complete execution
 * config, and the m1_enabled flag. Nothing here is real data.
 */
import fs from "node:fs";
import path from "node:path";
import { connectLumi } from "../src/lib/lumi-m1/pg-adapter";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
const sql = connectLumi(url, { max: 2 });

(async () => {
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS lumi_dev_migrations (file text PRIMARY KEY)`);
  const dir = path.resolve(process.cwd(), "src/lib/db/migrations");
  const done = new Set((await sql.unsafe(`SELECT file FROM lumi_dev_migrations`)).map((r: any) => r.file));
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
    if (done.has(f)) continue;
    for (const st of fs.readFileSync(path.join(dir, f), "utf8").split("--> statement-breakpoint")) if (st.trim()) await sql.unsafe(st);
    await sql.unsafe(`INSERT INTO lumi_dev_migrations(file) VALUES ($1)`, [f]);
    console.log("migrated", f);
  }
  for (const [email, role] of [["owner@dev.local", "OWNER"], ["admin@dev.local", "ADMIN"], ["viewer@dev.local", "VIEWER"]]) {
    await sql.unsafe(`INSERT INTO email_allowlist(email,role,added_by) VALUES ($1,$2::app_role,'seed') ON CONFLICT (email) DO UPDATE SET role=EXCLUDED.role`, [email, role]);
    await sql.unsafe(`INSERT INTO lumi_actors(actor_ref,role,channel) VALUES ($1,$2,'WEB') ON CONFLICT (actor_ref) DO UPDATE SET role=EXCLUDED.role`, [`web:${email}`, role]);
  }
  await sql.unsafe(`INSERT INTO lumi_actors(actor_ref,role,channel) VALUES ('telegram:1001','OWNER','TELEGRAM') ON CONFLICT (actor_ref) DO NOTHING`);
  await sql.unsafe(`INSERT INTO profiles(slug,name,type,status) VALUES ('lumitest','Bot thử Dong-Lumi','bot','active') ON CONFLICT DO NOTHING`);
  await sql.unsafe(`INSERT INTO lumi_projects(slug,name,area) VALUES ('test-offer-us','Test offer US','AFFILIATE') ON CONFLICT (slug) DO NOTHING`);
  await sql.unsafe(
    `INSERT INTO lumi_assistants(slug,name,kind,hermes_profile,connection_state,execution_level,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day,description)
     VALUES ('lumitest','Lumi Test','SPECIALIST','lumitest','VERIFIED',0,'["tasks.intake","outputs.submit","knowledge.context"]',600,60,2,3,3,20,'Trợ lý thử (mô phỏng cho tới khi có Hermes thật)') ON CONFLICT (slug) DO NOTHING`);
  await sql.unsafe(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','seed',now()) ON CONFLICT (key) DO NOTHING`);
  console.log("seed ok (synthetic data only)");
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
