import "dotenv/config";
import { ingestProfile, ingestAll } from "../src/lib/ingestion/hermes-projector";
import { db } from "../src/lib/db";
import { profiles } from "../src/lib/db/schema/profiles";
import { hermesSessions, hermesMessages } from "../src/lib/db/schema/hermes";
import { tasks } from "../src/lib/db/schema/tasks";
import { count, desc } from "drizzle-orm";

async function main() {
  const profile = (process.argv[2] as "aff" | "yt" | "default") ?? "yt";
  console.log(`\n=== Ingest profile: ${profile} ===`);
  const r = await ingestProfile(profile);
  console.log(JSON.stringify(r, null, 2));

  console.log("\n=== Profiles seeded ===");
  console.log(await db.select().from(profiles));

  console.log("\n=== hermes_sessions ===");
  console.log(
    await db
      .select({
        profileSlug: hermesSessions.profileSlug,
        hermesSessionId: hermesSessions.hermesSessionId,
        source: hermesSessions.source,
        title: hermesSessions.title,
        messageCount: hermesSessions.messageCount,
      })
      .from(hermesSessions),
  );

  console.log("\n=== hermes_messages count ===");
  console.log(await db.select({ n: count() }).from(hermesMessages));

  console.log("\n=== tasks ===");
  console.log(
    await db
      .select({
        code: tasks.code,
        profileSlug: tasks.profileSlug,
        title: tasks.title,
        status: tasks.status,
      })
      .from(tasks)
      .orderBy(desc(tasks.updatedAt)),
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
