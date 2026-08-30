import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { NAV_ITEMS } from "../../components/layout/nav-items";
import {
  DASHBOARD_ROUTES,
  OPSHUB_DEPLOYED_COMMIT,
  REQUIRED_HEADER_ELEMENTS,
  REQUIRED_NAV_HREFS,
  SURFACES,
  SURFACE_STATUSES,
  storyIdOwnership,
  surfacesNeedingRemediation,
  unresolvedStoryIds,
  surfacesOwnedBy,
} from "./surfaces";

/**
 * P3-R08 — the regression gate that does not exist today.
 *
 * Nothing in this project would currently notice if a navigation item vanished
 * or a dashboard route lost its guard. That is the whole point of the
 * requirement, and this file is the deliverable.
 *
 * ## Two rules this file follows, both learned the hard way here
 *
 * **Comments are stripped before any source is scanned.** Guards in this
 * project have been tripped three times by prose in their own explanatory
 * comments. A check that cannot tell a comment from code punishes clear
 * writing.
 *
 * **The register is not compared to itself.** `REQUIRED_NAV_HREFS` is an
 * independent statement of design §7.1; `NAV_ITEMS` is the implementation. A
 * test that read the nav from the implementation and asserted it matched the
 * implementation would pass whatever the implementation said.
 */

const SRC = join(process.cwd(), "src");

/** Read a source file with comments removed. */
function readCode(relative: string): string {
  const raw = readFileSync(join(SRC, relative), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments, including JSX {/* */} bodies
    .replace(/^\s*\/\/.*$/gm, " "); // whole-line comments
}

// ─────────────────────────────────────────────────────────────────
// 0. CONTROL — the inventory is not vacuous  (AC-14)
// ─────────────────────────────────────────────────────────────────

test("CONTROL: the register is populated and every surface is classified exactly once", () => {
  assert.ok(SURFACES.length >= 10, `only ${SURFACES.length} surfaces registered`);

  for (const s of SURFACES) {
    assert.ok(
      (SURFACE_STATUSES as readonly string[]).includes(s.status),
      `${s.key}: status "${s.status}" is outside the closed vocabulary`,
    );
    assert.ok(s.evidence.trim().length > 20, `${s.key}: evidence is too thin to audit`);
  }

  const keys = SURFACES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate surface key");
});

test("CONTROL: the register carries BOTH a present and an absent surface", () => {
  // Without both, the inventory proves nothing: an all-conforming register
  // would also be produced by a scan that found nothing and shrugged.
  const conforming = SURFACES.filter((s) => s.status === "EXISTING_AND_CONFORMING");
  const absent = SURFACES.filter((s) => s.status === "NOT_IMPLEMENTED");

  assert.ok(conforming.length > 0, "no conforming surface -- the gate asserts nothing");
  assert.ok(
    absent.length > 0,
    "no NOT_IMPLEMENTED surface -- an inventory that never reports an absence is not an inventory",
  );

  // `telegram-control-plane` is named because it is absent for a reason that
  // does not expire: P3 built the control plane and deliberately shipped no UI
  // for it. If that key ever stops being absent, someone built a Telegram
  // surface and this gate should be read again.
  const absentKeys = absent.map((s) => s.key);
  assert.ok(absentKeys.includes("telegram-control-plane"));

  // `money-os-surfaces` USED to be named here too, and that was a mistake in
  // the same class as M-15: a control pinned to a fact that changes when work
  // lands. P4-R11 built it on 2026-08-30 and the control failed -- not because
  // the register was wrong, but because the fixture had encoded "this will
  // always be missing" about a requirement whose whole purpose was to build it.
  //
  // The control's real claim is that the register reports BOTH states, and that
  // is asserted above without naming a key that success can invalidate.
  assert.ok(
    conforming.some((s) => s.key === "money-os-surfaces"),
    "money-os-surfaces should now be conforming -- P4-R11 built it",
  );
});

test("CONTROL: a remediation names the criterion it fails", () => {
  const needing = surfacesNeedingRemediation();
  assert.ok(needing.length > 0, "no remediation recorded -- did the inventory actually run?");

  for (const s of needing) {
    assert.ok(
      s.failsCriterion && /^P3-R08 AC-\d\d$/.test(s.failsCriterion),
      `${s.key}: EXISTING_NEEDS_REMEDIATION without a named criterion is a preference, not a finding`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────
// 1. Navigation — the closed set  (AC-05)
// ─────────────────────────────────────────────────────────────────

test("AC-05: the nav item set matches design §7.1 exactly -- no silent addition or removal", () => {
  const actual = NAV_ITEMS.map((i) => i.href as string);

  assert.deepEqual(
    actual,
    [...REQUIRED_NAV_HREFS],
    "navigation drifted from design §7.1. Adding or removing an item is a design change " +
      "and must go through the requirement, not through a component edit.",
  );
});

test("AC-05: every nav item is usable -- label, icon, section, and a working match()", () => {
  for (const item of NAV_ITEMS) {
    assert.ok(item.label.trim().length > 0, `${item.href}: empty label`);
    assert.ok(item.icon, `${item.href}: no icon`);
    assert.ok(
      item.section === "business" || item.section === "admin",
      `${item.href}: section "${item.section}" is outside the closed set`,
    );
    assert.equal(item.match(item.href as string), true, `${item.href}: match() fails its own href`);
  }
});

test("AC-05: match() is specific -- /admin does not claim /aff", () => {
  // A match() written as `p.startsWith("/a")` would highlight the wrong item and
  // nothing would catch it.
  for (const item of NAV_ITEMS) {
    for (const other of NAV_ITEMS) {
      if (item.href === other.href || other.href === "/") continue;
      assert.equal(
        item.match(other.href as string) && item.href !== other.href,
        false,
        `${item.href} also matches ${other.href}`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// 2. Header — present AND reachable  (AC-06)
// ─────────────────────────────────────────────────────────────────

test("AC-06: every design §7.3 element is mounted in the global header", () => {
  const code = readCode("components/layout/global-header.tsx");

  for (const element of REQUIRED_HEADER_ELEMENTS) {
    assert.ok(
      new RegExp(`<${element}[\\s/>]`).test(code),
      `<${element} /> is not mounted in the global header (design §7.3)`,
    );
  }
});

test("AC-06: the header carries no permanently inert control", () => {
  // The finding this criterion was written against: `+ Tạo nhiệm vụ` ships
  // hard-disabled with an aria-label promising it "sẽ có ở DC-005" — and DC-005
  // shipped. AC-06 requires elements reachable, not merely rendered.
  //
  // Recorded as EXISTING_NEEDS_REMEDIATION rather than fixed here: this
  // requirement inventories and gates, and remediation is its own change with
  // its own evidence.
  const code = readCode("components/layout/global-header.tsx");
  const hardDisabled = /\n\s*disabled\s*\n/.test(code) || /\sdisabled(\s|>|\/)/.test(code);

  const known = SURFACES.find((s) => s.key === "global-header");
  assert.ok(known, "global-header surface missing from the register");

  if (hardDisabled) {
    assert.equal(
      known.status,
      "EXISTING_NEEDS_REMEDIATION",
      "the header contains a hard-disabled control but the register calls it conforming",
    );
  } else {
    assert.equal(
      known.status,
      "EXISTING_AND_CONFORMING",
      "the inert control appears to be gone -- update the register rather than leaving a stale finding",
    );
  }
});

test("AC-06: the shell mounts the header, the sidebar and a main landmark", () => {
  const code = readCode("components/layout/app-shell.tsx");
  assert.match(code, /<Sidebar\s*\/>/, "AppShell does not mount the sidebar");
  assert.match(code, /<GlobalHeader\s*\/>/, "AppShell does not mount the global header");
  assert.match(code, /<main\b/, "AppShell has no <main> landmark");
});

// ─────────────────────────────────────────────────────────────────
// 3. Every dashboard route is guarded  (AC-08)
// ─────────────────────────────────────────────────────────────────

/**
 * Extract the middleware matcher from the real file rather than duplicating it.
 * A copy here would keep passing after the real matcher changed — which is the
 * failure this test exists to prevent.
 */
function middlewareMatcher(): RegExp {
  const code = readCode("middleware.ts");
  const m = code.match(/matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/);
  assert.ok(m?.[1], "could not read the middleware matcher — the guard cannot be verified");
  // ANCHORED. Next.js anchors matcher patterns implicitly; `new RegExp` does
  // not. Unanchored, `/api/auth/callback/google` matches starting at offset 4 —
  // the negative lookahead only fires at the position the match begins from —
  // and the control below would report the guard covering a route it exempts.
  return new RegExp(`^${m[1].replace(/\\\\/g, "\\")}$`);
}

test("AC-08: every (dashboard) route is matched by the auth middleware", () => {
  const matcher = middlewareMatcher();

  for (const route of DASHBOARD_ROUTES) {
    assert.equal(
      matcher.test(route),
      true,
      `${route} is NOT matched by the middleware — it would be served unauthenticated`,
    );
  }
});

test("AC-08 CONTROL: the matcher genuinely excludes something", () => {
  // A matcher of /.*/ would pass the test above while guarding nothing
  // meaningful. These must be excluded, or the login page itself would redirect
  // to the login page.
  const matcher = middlewareMatcher();

  for (const open of ["/login", "/api/auth/callback/google", "/api/health"]) {
    assert.equal(
      matcher.test(open),
      false,
      `${open} is matched by the guard — it must stay reachable unauthenticated`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────
// 4. Ownership and provenance  (AC-03, AC-04, AC-10, AC-12, AC-13)
// ─────────────────────────────────────────────────────────────────

test("AC-03: no live surface is governed only by a superseded story id", () => {
  // The criterion allows a story id to resolve to a canonical requirement "or to
  // another canonical id where one applies". For the YouTube workspace none
  // applies — that IS CSG-02 — so demanding a requirement here would be stricter
  // than the criterion and would force a phase to be invented on the spot.
  //
  // What must never happen is a story id resolving to nothing at all.
  const ownership = storyIdOwnership();
  assert.ok(ownership.size > 0, "no story ids mapped — CSG-01 would be unresolved");

  assert.deepEqual(
    unresolvedStoryIds(),
    [],
    "a story id governing a live surface resolves to neither a canonical requirement " +
      "nor a recorded disposition — that is the CSG-01 hole reopening",
  );
});

test("AC-03: an UNASSIGNED surface must name the record that explains it", () => {
  for (const s of SURFACES) {
    if (s.owner !== "UNASSIGNED") continue;
    assert.match(
      s.dispositionRecord ?? "",
      /^CSG-\d\d$/,
      `${s.key}: UNASSIGNED without a disposition record is an omission, not a decision`,
    );
  }
});

test("AC-04: DC-011b has an owner and is no longer a production-only promise", () => {
  const ownership = storyIdOwnership();
  assert.equal(
    ownership.get("DC-011b"),
    "P4-R11",
    "DC-011b is promised in shipped production copy; it must resolve to a canonical requirement",
  );
});

test("AC-10: the Overview stays scoped to the shell -- Money OS surfaces are P4-R11's", () => {
  const overview = SURFACES.find((s) => s.key === "overview");
  assert.equal(overview?.owner, "P3-R08");

  const moneyOs = SURFACES.find((s) => s.key === "money-os-surfaces");
  assert.equal(
    moneyOs?.owner,
    "P4-R11",
    "the AI Money OS surfaces belong to P4-R11; folding them into the Overview would " +
      "quietly move P4 scope into P3",
  );
});

test("AC-12: the YouTube workspace is UNASSIGNED on purpose, not by omission", () => {
  const yt = SURFACES.find((s) => s.key === "youtube-workspace");
  assert.equal(yt?.owner, "UNASSIGNED");
  assert.match(
    yt?.evidence ?? "",
    /CSG-02/,
    "an UNASSIGNED surface must point at the record that explains why",
  );
});

test("AC-13: the register describes one runtime -- no third repo or app", () => {
  // Every surface here belongs to this Next.js app. A surface pointing at
  // another runtime would mean app.dongchannel.com had been split.
  for (const s of SURFACES) {
    assert.equal(
      /https?:\/\//.test(s.evidence.replace(/dongchannel\.com/g, "")),
      false,
      `${s.key}: evidence names an external runtime`,
    );
  }
});

test("AC-01: the inventory records the commit it was taken against", () => {
  assert.match(
    OPSHUB_DEPLOYED_COMMIT,
    /^[0-9a-f]{7,40}$/,
    "the inventory must name the deployed commit it was compiled against",
  );
});

test("P3-R08 owns the shell; P4-R11 owns the domain content", () => {
  const shell = surfacesOwnedBy("P3-R08").map((s) => s.key);
  assert.ok(shell.includes("global-navigation"));
  assert.ok(shell.includes("global-header"));
  assert.ok(shell.includes("overview"));
  assert.ok(shell.includes("admin-shell"));

  const domain = surfacesOwnedBy("P4-R11").map((s) => s.key);
  assert.ok(domain.includes("money-os-surfaces"));
  assert.ok(domain.includes("aff-workspace-domain"));
});

// ─────────────────────────────────────────────────────────────────
// 5. Profile switcher is a filter, not a page  (AC-07)
// ─────────────────────────────────────────────────────────────────

test("AC-07: the profile switcher is a cross-module filter, not a route", () => {
  // Design §7.2: "Profile là bộ lọc xuyên suốt, không phải một trang riêng
  // trong luồng nghiệp vụ." A /profile route would make it a destination.
  const navHrefs = NAV_ITEMS.map((i) => i.href as string);
  assert.equal(
    navHrefs.some((h) => h.startsWith("/profile")),
    false,
    "the profile switcher has become a navigation destination — §7.2 makes it a filter",
  );

  // It is mounted in the header, which is what makes it span every module.
  const header = readCode("components/layout/global-header.tsx");
  assert.match(
    header,
    /<ProfileSwitcher[\s/>]/,
    "the profile switcher is not in the global header, so it cannot span modules",
  );

  // And the filter context wraps every dashboard route.
  const layout = readCode("app/(dashboard)/layout.tsx");
  assert.match(
    layout,
    /<ProfileFilterProvider/,
    "the dashboard layout does not provide the profile filter",
  );
});

// ─────────────────────────────────────────────────────────────────
// 6. The Overview reports only what it read  (AC-09)
// ─────────────────────────────────────────────────────────────────

test("AC-09: a KPI with no backing query is UNKNOWN, never 0", () => {
  // The finding this criterion caught: `activeTests` shipped as a hard-coded
  // `0` with a comment saying it awaited DC-011/DC-012 — both of which had
  // already landed. The Overview reported "Test đang active: 0" as a
  // measurement for as long as it had been live.
  const code = readCode("lib/dashboard/summary.ts");

  // No KPI field may be assigned a bare numeric literal. A real count comes
  // from a query; a literal is a value nobody measured.
  const literalAssignments = code.match(
    /\b(pendingReview|running|alerts|activeTests)\s*:\s*-?\d+\s*[,\n]/g,
  );
  assert.equal(
    literalAssignments,
    null,
    `a KPI is assigned a hard-coded number: ${literalAssignments?.join(", ")}. ` +
      "If there is no query behind it, the value is UNKNOWN (null), not 0.",
  );
});

test("AC-09: the KPI grid renders UNKNOWN as text, not as a dimmed zero", () => {
  // Colour is not a value. The previous implementation distinguished "chưa có"
  // from "0 thực sự" only by opacity, and a screen reader read both as "0".
  const code = readCode("components/dashboard/kpi-grid.tsx");

  assert.match(code, /UNKNOWN/, "the KPI grid has no UNKNOWN rendering path");
  assert.match(
    code,
    /value === null/,
    "the KPI grid does not distinguish a null (unmeasured) value from a numeric one",
  );
  assert.match(
    code,
    /aria-label=\{isUnknown \?/,
    "the accessible label does not distinguish UNKNOWN — a screen reader would still hear a number",
  );
});
