/**
 * Paths that a service token (bot) may call WITHOUT a browser session. The middleware lets exactly these through when the
 * `x-dc-service-token` header is present; the route handler then verifies the token itself and fails closed (401) if it is
 * missing/wrong. Everything else (adopt, decide, retry/runs, transition, dispatch, flags, PATCH of drafts…) still needs a
 * signed-in user — a service token never reaches them (and the handlers reject bots again, defence in depth).
 */
const RULES: { method: string; re: RegExp }[] = [
  { method: "POST", re: /^\/api\/v1\/tasks\/intake$/ },
  { method: "POST", re: /^\/api\/v1\/tasks\/intake\/[^/]+\/confirm$/ },
  { method: "POST", re: /^\/api\/v1\/tasks\/[0-9a-f-]{36}\/outputs$/i },
  { method: "POST", re: /^\/api\/v1\/runs\/[0-9a-f-]{36}\/ack$/i },
];
export function isServiceTokenPath(method: string, pathname: string): boolean {
  return RULES.some((r) => r.method === method && r.re.test(pathname));
}
