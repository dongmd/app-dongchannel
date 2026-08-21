// Secret redaction for the structured logger.
//
// Kept separate from log.ts so it can be unit-tested: log.ts imports
// "server-only", which refuses to load outside a server context and so cannot
// be pulled into a plain test process. Redaction is the part of logging whose
// failure is silent and permanent, so it is the part that needs tests.

export const REDACTED = "<REDACTED>";

// Redact common secret patterns (defensive — không thay thế review code).
const SECRET_PATTERNS: [RegExp, string][] = [
  [/GOCSPX-[A-Za-z0-9_-]{20,}/g, "GOCSPX-<REDACTED>"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-<REDACTED>"],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <REDACTED>"],
  [/Basic\s+[A-Za-z0-9+/=]+/g, "Basic <REDACTED>"],

  // postgres://user:password@host → postgres://user:<REDACTED>@host
  //
  // The most likely leak in this app, and the one the original pattern list
  // did not cover: DATABASE_URL is a DSN with the password inline, and
  // postgres-js quotes the connection target back at you when a connection
  // fails. Username and host survive so the line is still debuggable.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi, `$1${REDACTED}$3`],

  // Telegram bot token — `<bot_id>:<35-char secret>` (P3-R01 AC-06).
  //
  // None of the patterns above catch it. It carries no scheme, so the DSN rule
  // misses it; and it leaks BARE, not as `token=...`, because that is exactly
  // how it appears inside an API URL — https://api.telegram.org/bot<TOKEN>/...
  // A failed request quoting its own URL would otherwise print the credential
  // in full. Anchored on the colon-separated shape rather than on a key name,
  // since there is no key name to key on.
  // Two patterns, not one clever one. In the API URL the token is preceded by
  // the literal `bot`, and `\b` does NOT fire between `t` and a digit — both are
  // word characters — so a single bare-token rule silently missed the exact
  // place the credential actually appears.
  [/\bbot\d{6,12}:[A-Za-z0-9_-]{30,}/g, `bot<TELEGRAM_TOKEN_${REDACTED}>`],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, `<TELEGRAM_TOKEN_${REDACTED}>`],

  // password=... / "token": "..." / api_key: '...'
  [
    /((?:password|passwd|secret|token|api[_-]?key)["'\s]*[:=]["'\s]*)([^\s"',;&}]+)/gi,
    `$1${REDACTED}`,
  ],
];

// Key names whose value is replaced whole, whatever it looks like.
const SECRET_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "private_key",
  "cookie",
  "database_url",
  "databaseurl",
  "dsn",
  "nextauth_secret",
  "client_secret",
];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEYS.some((s) => k.includes(s));
}

export function scrub(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// `seen` guards against circular structures. Without it a cycle turns a log
// call into a stack overflow — and the log call is usually the thing trying to
// report the problem.
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") {
    return scrub(value);
  }
  if (!value || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  // An Error spreads to {} — message and stack both vanish. Stacks matter here
  // because postgres-js puts the connection target in them.
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrub(value.message),
      stack: value.stack ? scrub(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? REDACTED : redact(item, seen);
  }
  return out;
}

