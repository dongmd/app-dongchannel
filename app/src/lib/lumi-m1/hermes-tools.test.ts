import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHermesToolsList, profileWithinAllowlist } from "./hermes-tools";

// Verbatim excerpt of `docker exec hermes hermes -p aff tools list` on the production VPS (read-only), 2026-11-06.
const SAMPLE = `Built-in toolsets (cli):
  ✓ enabled  web  🔍 Web Search & Scraping
  ✓ enabled  terminal  💻 Terminal & Processes
  ✓ enabled  file  📁 File Operations
  ✗ disabled  video  🎬 Video Analysis
  ✓ enabled  memory  💾 Memory
  ✓ enabled  computer_use  🖱️  Computer Use (macOS/Windows/Linux)
`;

describe("Hermes tools list parsing (real captured output)", () => {
  it("separates enabled and disabled toolsets", () => {
    const p = parseHermesToolsList(SAMPLE);
    assert.equal(p[0]!.platform, "cli");
    assert.deepEqual(p[0]!.enabled, ["web", "terminal", "file", "memory", "computer_use"]);
    assert.deepEqual(p[0]!.disabled, ["video"]);
  });
  it("a production-style profile is NOT within a minimal test allowlist; a stripped profile is; unparseable output is refused", () => {
    const p = parseHermesToolsList(SAMPLE);
    const r = profileWithinAllowlist(p, ["memory"]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.extra, ["computer_use", "file", "terminal", "web"]);
    assert.equal(profileWithinAllowlist(parseHermesToolsList("Built-in toolsets (cli):\n  ✓ enabled  memory  x\n"), ["memory"]).ok, true);
    assert.equal(profileWithinAllowlist(parseHermesToolsList("garbage"), ["memory"]).ok, false);
  });
});

describe("Hermes MCP section (shape of the real `hermes -p lumitest tools list`, 2026-11-06)", () => {
  const nl = String.fromCharCode(10);
  const MCP = ["Built-in toolsets (cli):", "  ✗ disabled  web  x", "", "MCP servers:", "  lumiapp  [include only: tasks_intake, knowledge_context, outputs_submit]", ""].join(nl);
  it("lists exact MCP tools as server:tool; an unrestricted server is server:*", () => {
    const p = parseHermesToolsList(MCP);
    assert.deepEqual(p.find((x) => x.platform === "mcp")!.enabled, ["lumiapp:tasks_intake", "lumiapp:knowledge_context", "lumiapp:outputs_submit"]);
    assert.deepEqual(parseHermesToolsList(["MCP servers:", "  lumiapp  all tools enabled", ""].join(nl)).find((x) => x.platform === "mcp")!.enabled, ["lumiapp:*"]);
  });
});
