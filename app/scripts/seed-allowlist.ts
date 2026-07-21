// Bootstrap allowlist. Chạy sau khi migrate:
//   pnpm exec tsx scripts/seed-allowlist.ts
//
// Idempotent — chạy nhiều lần không sinh trùng.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { emailAllowlist } from "../src/lib/db/schema/identity";

async function main() {
  const raw = process.env.AUTH_EMAIL_ALLOWLIST;
  if (!raw) {
    console.error("AUTH_EMAIL_ALLOWLIST env var chưa set — không có gì để seed.");
    process.exit(1);
  }
  const entries = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) {
    console.error("AUTH_EMAIL_ALLOWLIST rỗng.");
    process.exit(1);
  }

  // Same policy as env fallback: chỉ email ĐẦU TIÊN được OWNER, còn lại VIEWER.
  // Tránh privilege escalation ngoài ý muốn khi operator liệt kê nhiều email trong env.
  for (let i = 0; i < entries.length; i++) {
    const email = entries[i]!;
    const role = i === 0 ? "OWNER" : "VIEWER";
    await db
      .insert(emailAllowlist)
      .values({ email, role, addedBy: "seed:bootstrap" })
      .onConflictDoNothing({ target: emailAllowlist.email });
    console.log(`✓ seed ${email} (${role})`);
  }

  const count = await db.execute(sql`SELECT count(*)::int AS n FROM email_allowlist`);
  console.log(`Total allowlist entries: ${JSON.stringify(count[0])}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
