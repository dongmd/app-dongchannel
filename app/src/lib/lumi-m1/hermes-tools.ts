/**
 * Parses the output of `hermes -p <profile> tools list` (Hermes v0.18.2, captured from the VPS on 2026-11-06, read-only).
 * Hermes expresses capabilities as built-in TOOLSETS (web, terminal, file, ...) and MCP tools as `server:tool`.
 * Activation (TDD 8.8) must refuse a profile whose enabled set is not a subset of the allowed set.
 */
const NL = String.fromCharCode(10);
export function parseHermesToolsList(text: string): { platform: string; enabled: string[]; disabled: string[] }[] {
  const out: { platform: string; enabled: string[]; disabled: string[] }[] = [];
  let cur: { platform: string; enabled: string[]; disabled: string[] } | null = null;
  for (const raw of text.split("\n")) {
    const head = raw.match(/^Built-in toolsets \(([^)]+)\):/i) ?? raw.match(/^MCP tools \(([^)]+)\):/i);
    if (head) {
      cur = out.find((p) => p.platform === head[1]) ?? { platform: head[1]!, enabled: [], disabled: [] };
      if (!out.includes(cur)) out.push(cur);
      continue;
    }
    const m = raw.match(/^\s*[✓✗]\s+(enabled|disabled)\s+(\S+)/u);
    if (m && cur) (m[1] === "enabled" ? cur.enabled : cur.disabled).push(m[2]!);
  }
  // MCP servers section: `  name  [include only: a, b]` (exact tools) or `  name  all tools enabled` (unknown set => `name:*`, which no allowlist contains).
  let inMcp = false;
  const mcp: string[] = [];
  for (const raw of text.split(NL)) {
    if (/^MCP servers:/i.test(raw)) { inMcp = true; continue; }
    if (inMcp && /^\S/.test(raw)) inMcp = false;
    const m = inMcp ? raw.match(/^\s+(\S+)\s+(.*)$/) : null;
    if (!m) continue;
    const inc = m[2]!.match(/\[include only:\s*([^\]]*)\]/i);
    if (inc) for (const t of inc[1]!.split(",").map((x) => x.trim()).filter(Boolean)) mcp.push(`${m[1]}:${t}`);
    else if (/all tools enabled/i.test(m[2]!)) mcp.push(`${m[1]}:*`);
  }
  if (mcp.length) out.push({ platform: "mcp", enabled: mcp, disabled: [] });
  return out;
}

/** True when every enabled toolset/tool of the profile is in the allowed set. `extra` lists the offenders. */
export function profileWithinAllowlist(parsed: ReturnType<typeof parseHermesToolsList>, allowed: string[]): { ok: boolean; extra: string[] } {
  const extra = [...new Set(parsed.flatMap((p) => p.enabled))].filter((t) => !allowed.includes(t)).sort();
  return { ok: extra.length === 0 && parsed.length > 0, extra };
}
