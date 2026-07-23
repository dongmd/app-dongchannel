import "server-only";

// AC03 — structured logger, không dep. Non-PII fields only (email/token redacted).
// Route/handler tự truyền request_id qua context.

type Level = "debug" | "info" | "warn" | "error";

interface LogFields {
  request_id?: string;
  profile_id?: string;
  task_id?: string;
  session_id?: string;
  user_id?: string;
  route?: string;
  status?: number;
  duration_ms?: number;
  [key: string]: unknown;
}

// Redact common secret patterns (defensive — không thay thế review code).
const SECRET_PATTERNS: [RegExp, string][] = [
  [/GOCSPX-[A-Za-z0-9_-]{20,}/g, "GOCSPX-<REDACTED>"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-<REDACTED>"],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <REDACTED>"],
  [/Basic\s+[A-Za-z0-9+/=]+/g, "Basic <REDACTED>"],
];

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const arr = Array.isArray(value) ? [...value] : { ...value };
    for (const key of Object.keys(arr as Record<string, unknown>)) {
      (arr as Record<string, unknown>)[key] = redact((arr as Record<string, unknown>)[key]);
    }
    return arr;
  }
  return value;
}

function write(level: Level, message: string, fields: LogFields = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message: typeof message === "string" ? (redact(message) as string) : String(message),
    ...(redact(fields) as LogFields),
  };
  const line = JSON.stringify(entry);
  // Console methods per level — dev nhìn thấy màu; prod sink capture stdout.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, f?: LogFields) => {
    if (process.env.NODE_ENV !== "production") write("debug", msg, f);
  },
  info: (msg: string, f?: LogFields) => write("info", msg, f),
  warn: (msg: string, f?: LogFields) => write("warn", msg, f),
  error: (msg: string, f?: LogFields) => write("error", msg, f),
};
