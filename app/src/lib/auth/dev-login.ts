/**
 * Local-development sign-in WITHOUT Google, so the M1 UI can be exercised against a throwaway database.
 * Enabled only when ALL hold: NODE_ENV is not "production"; LUMI_DEV_LOGIN=1; and NEXTAUTH_URL is set and points at this
 * machine (localhost / 127.0.0.1 / [::1]). The email must still pass the normal allowlist check in the signIn callback.
 * It must never be enabled on staging/production: there NODE_ENV=production and the URL is a real host, so any one of the
 * three conditions already fails.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isDevLoginEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV === "production" || env.LUMI_DEV_LOGIN !== "1") return false;
  try {
    return LOCAL_HOSTS.has(new URL(env.NEXTAUTH_URL ?? "").hostname);
  } catch {
    return false; // unset or unparsable URL: refuse
  }
}
