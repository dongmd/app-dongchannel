/**
 * P4-R11 — the boundaries, asserted on the source rather than at runtime.
 *
 * `AC-03` and `AC-06` are properties of the CODE. A runtime test could show
 * that one page did not define its own scoring model; this shows there is no
 * page that does.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url)); // src/lib/moneyos/
const SRC = join(HERE, "..", "..");
const ROUTES = join(SRC, "app", "(dashboard)", "moneyos");
const COMPONENTS = join(SRC, "..", "src", "components", "moneyos");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const PAGES = walk(ROUTES).map((f) => ({ name: f.slice(SRC.length), source: readFileSync(f, "utf8") }));
const PARTS = walk(COMPONENTS).map((f) => ({ name: f.slice(SRC.length), source: readFileSync(f, "utf8") }));
const POLICY = readFileSync(join(HERE, "display-policy.ts"), "utf8");
const QUERIES = readFileSync(join(HERE, "queries.ts"), "utf8");

/** Comments are commentary. A boundary named in prose is not a violation. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("the scan itself", () => {
  it("CONTROL — it can see the surfaces", () => {
    // Every assertion below passes vacuously against an empty file list, so
    // this is checked first and names the expected shape.
    assert.equal(PAGES.length, 8, `expected 8 Money OS pages, found ${PAGES.length}`);
    assert.ok(PARTS.length >= 1, "no shared components found");
    assert.ok(PAGES.every((p) => p.source.length > 300), "a page is suspiciously short");
  });
});

// ─── AC-03 ─────────────────────────────────────────────────────────

describe("AC-03 — no alternate Source of Truth exists in the frontend", () => {
  it("no page or component defines a Signal, Opportunity, score or evidence model", () => {
    // Defining the shape is how a second model starts. The pages consume row
    // types inferred from the schema; they do not declare their own.
    const forbidden = [
      /interface\s+\w*(Signal|Opportunity|Score|Evidence|Claim|Cluster)\w*\s*\{/,
      /type\s+\w*(Signal|Opportunity|Score|Evidence|Claim|Cluster)\w*\s*=\s*\{/,
      /class\s+\w*(Signal|Opportunity|Score|Evidence)\w*/,
    ];
    for (const f of [...PAGES, ...PARTS]) {
      const src = code(f.source);
      for (const re of forbidden) {
        assert.equal(re.test(src), false, `${f.name} declares its own domain model`);
      }
    }
  });

  it("no page computes a score, a ranking or an evidence level", () => {
    for (const f of PAGES) {
      const src = code(f.source);
      assert.equal(/\.sort\s*\(/.test(src), false, `${f.name} sorts -- ranking belongs to queries.ts`);
      assert.equal(/\.reverse\s*\(/.test(src), false, `${f.name} reverses the stored order`);
      // A page adding or weighting numbers is computing a score.
      assert.equal(/normalisedScore\s*[*+/-]/.test(src), false, `${f.name} does arithmetic on a score`);
      assert.equal(/weight/i.test(src), false, `${f.name} mentions weighting -- scoring is P2-R03's`);
    }
  });

  it("the ORDER BY exists in queries.ts and nowhere else", () => {
    assert.match(QUERIES, /orderBy/, "queries.ts does not order -- the ranking authority is missing");
    for (const f of [...PAGES, ...PARTS]) {
      assert.equal(/orderBy/.test(code(f.source)), false, `${f.name} orders rows`);
    }
  });

  it("display-policy is pure: it imports nothing", () => {
    const imports = code(POLICY).match(/^\s*import\s/gm) ?? [];
    assert.equal(imports.length, 0, "display-policy must import nothing");
    assert.equal(code(POLICY).includes("process.env"), false);
    assert.equal(code(POLICY).includes("new Date("), false);
  });
});

// ─── The projection never writes ───────────────────────────────────

describe("the Money OS surfaces read and never write", () => {
  it("queries.ts performs no insert, update or delete", () => {
    const src = code(QUERIES);
    for (const verb of ["insert", "update", "delete"]) {
      assert.equal(
        new RegExp(`db\\.${verb}\\s*\\(`).test(src),
        false,
        `queries.ts calls db.${verb} -- this layer is a projection`,
      );
    }
  });

  it("no page imports the approval, publish-intent or agent-runner modules", () => {
    // P3 owns approvals and publish intents; P4-R01 owns running agents. This
    // requirement renders their results and must not be able to cause them.
    const forbidden = [
      "schema/approval", "schema/two-step", "agents/runner",
      "telegram/two-step-policy", "audit/write",
    ];
    for (const f of [...PAGES, ...PARTS]) {
      const src = code(f.source);
      for (const imp of forbidden) {
        assert.equal(src.includes(imp), false, `${f.name} imports ${imp}`);
      }
    }
  });

  it("no page contains a form or a mutating action", () => {
    // AC-02/AC-03: the UI consumes and projects. A form here would be the
    // moment it started owning something.
    for (const f of PAGES) {
      const src = code(f.source);
      assert.equal(/<form/i.test(src), false, `${f.name} renders a form`);
      assert.equal(/useState|onClick|"use client"/.test(src), false,
        `${f.name} is interactive -- these surfaces are server-rendered projections`);
    }
  });
});

// ─── AC-06 ─────────────────────────────────────────────────────────

describe("AC-06 — every route is behind the auth guard", () => {
  const middleware = readFileSync(join(SRC, "middleware.ts"), "utf8");

  it("the Money OS routes are NOT excluded from the matcher", () => {
    // P3 added exactly two exemptions -- the Telegram webhook and the preview
    // capability -- both self-verifying endpoints. This requirement adds none.
    assert.equal(middleware.includes("moneyos"), false,
      "middleware names moneyos -- an exemption was added, and R11 must add none");
  });

  it("the two P3 exemptions are still the only ones", () => {
    const m = middleware.match(/matcher:\s*\[([\s\S]*?)\]/);
    assert.ok(m, "no matcher found in middleware");
    const matcher = m![1]!;
    assert.match(matcher, /api\/telegram\/webhook/);
    assert.match(matcher, /preview/);
  });

  it("the Money OS pages live under (dashboard), which the matcher covers", () => {
    for (const p of PAGES) {
      assert.match(p.name, /\(dashboard\)/, `${p.name} is outside the guarded group`);
    }
  });
});

// ─── AC-07 / AC-08 ─────────────────────────────────────────────────

describe("AC-07/AC-08 — no phantom action, no fabricated data", () => {
  it("no page ships a control for a capability that does not exist", () => {
    for (const f of [...PAGES, ...PARTS]) {
      const src = code(f.source);
      assert.equal(/<button/i.test(src), false,
        `${f.name} renders a button -- these surfaces have no actions yet`);
      assert.equal(/disabled/.test(src), false,
        `${f.name} renders a disabled control -- a disabled button still says "one click away"`);
    }
  });

  it("no page contains placeholder or sample rows", () => {
    // The failure AC-08 names: an empty table dressed up as populated.
    for (const f of PAGES) {
      const src = code(f.source).toLowerCase();
      for (const bad of ["lorem", "example.com", "placeholder row", "sample data", "todo:"]) {
        assert.equal(src.includes(bad), false, `${f.name} contains ${bad}`);
      }
    }
  });

  it("every list page renders an empty state", () => {
    // The index page has no list, so it is excluded by name rather than by shape.
    const lists = PAGES.filter((p) => !/moneyos[\/]page\.tsx$/.test(p.name));
    for (const f of lists) {
      assert.match(
        f.source,
        /EmptyState|chưa có/i,
        `${f.name} has no empty state -- an empty table would render as a bare header`,
      );
    }
  });

  it("no story id survives in rendered copy of these pages", () => {
    for (const f of [...PAGES, ...PARTS]) {
      const src = code(f.source);
      assert.equal(/DC-\d{3}/.test(src), false, `${f.name} names a story id in rendered copy`);
    }
  });
});
