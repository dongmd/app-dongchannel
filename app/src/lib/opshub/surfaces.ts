/**
 * P3-R08 — the Ops Hub shell, canonicalised.
 *
 * The shell of `app.dongchannel.com` was built, deployed and running in
 * production before any canonical requirement owned it. It was governed by
 * `DC-001`…`DC-018` — story ids in `docs/TDD.md` §29, a document this
 * repository's own `CLAUDE.md` marks **SUPERSEDED**. `CSG-01` recorded that,
 * and the owner approved canonicalising it on 2026-08-21.
 *
 * ## This module is a register, not an implementation
 *
 * It declares what each surface **is** and what would prove it present. It
 * renders nothing, imports nothing, and is deliberately free of React so the
 * regression gate can run under `tsx --test` with no DOM and no build step.
 *
 * ## Why it exists at all
 *
 * Today nothing in this project would notice if a navigation item vanished or
 * a route lost its guard. The surfaces are real, the users are real, and the
 * register that tracks 31 of 68 requirements does not mention any of them.
 *
 * ## What it is NOT
 *
 * Not a licence to rebuild. A surface classified `EXISTING_AND_CONFORMING` is
 * left alone. Rewriting working UI to manufacture work for a new requirement is
 * out of scope — owner instruction, 2026-08-21.
 */

// ─── Classification ───────────────────────────────────────────────
//
// Exactly one per surface. A surface with no classification is a hole in the
// inventory, not a pass -- which is why `SurfaceRecord.status` is required and
// the vocabulary is closed.

export const SURFACE_STATUSES = [
  "EXISTING_AND_CONFORMING",
  "EXISTING_NEEDS_REMEDIATION",
  "NOT_IMPLEMENTED",
] as const;

export type SurfaceStatus = (typeof SURFACE_STATUSES)[number];

/** The phase that owns a surface. The shell is P3; domain content is P4. */
export const SURFACE_OWNERS = ["P3-R08", "P4-R11", "UNASSIGNED"] as const;
export type SurfaceOwner = (typeof SURFACE_OWNERS)[number];

export interface SurfaceRecord {
  /** Stable key. Never renamed -- traceability rows point at it. */
  readonly key: string;
  readonly title: string;
  /** The canonical requirement that owns it after this reconciliation. */
  readonly owner: SurfaceOwner;
  /**
   * The story ids that governed it before. Kept, not erased: a surface whose
   * only provenance was a superseded story id is exactly what `CSG-01` is
   * about, and deleting the trail would hide how it happened.
   */
  readonly formerlyGovernedBy: readonly string[];
  /** Section of the canonical Ops Hub design this surface answers to. */
  readonly designSection: string | null;
  readonly status: SurfaceStatus;
  /**
   * Required when `owner` is `UNASSIGNED`. Names the record that carries the
   * open disposition, so "no canonical requirement applies" is a decision on
   * file rather than an omission nobody noticed.
   */
  readonly dispositionRecord?: string;
  /**
   * Present only for `EXISTING_NEEDS_REMEDIATION`. Names the criterion it
   * fails. A remediation without a named criterion is a preference.
   */
  readonly failsCriterion?: string;
  readonly evidence: string;
}

// ─── The register ─────────────────────────────────────────────────
//
// Compiled against commit 22f546b, which is BOTH the local HEAD and the
// deployed commit -- verified rather than assumed, because AC-01 requires the
// inventory to be taken against what is deployed.

export const OPSHUB_DEPLOYED_COMMIT = "22f546b";

export const SURFACES: readonly SurfaceRecord[] = [
  {
    key: "global-navigation",
    title: "Global navigation / sidebar",
    owner: "P3-R08",
    formerlyGovernedBy: ["DC-002"],
    designSection: "7.1",
    status: "EXISTING_AND_CONFORMING",
    evidence:
      "src/components/layout/nav-items.ts declares exactly the six items of design §7.1, " +
      "in the §8.1 wireframe order; sidebar.tsx renders them; app-shell.tsx mounts it.",
  },
  {
    key: "global-header",
    title: "Global header",
    owner: "P3-R08",
    formerlyGovernedBy: ["DC-002", "DC-003", "DC-013", "DC-015"],
    designSection: "7.3",
    status: "EXISTING_NEEDS_REMEDIATION",
    failsCriterion: "P3-R08 AC-06",
    evidence:
      "All §7.3 elements are mounted -- search, notifications, profile switcher, status " +
      "indicator, user menu -- but the `+ Tạo nhiệm vụ` action is hard-disabled and its " +
      "aria-label promises it 'sẽ có ở DC-005'. DC-005 shipped. AC-06 requires each element " +
      "reachable, not merely rendered, so a permanently inert control fails it.",
  },
  {
    key: "search",
    title: "Global search",
    owner: "P3-R08",
    formerlyGovernedBy: ["DC-013"],
    designSection: "7.3",
    status: "EXISTING_AND_CONFORMING",
    evidence: "src/components/layout/header-search.tsx + /search route (cross-entity FTS).",
  },
  {
    key: "notifications",
    title: "Notification surface",
    owner: "P3-R08",
    formerlyGovernedBy: ["DC-015"],
    designSection: "7.3",
    status: "EXISTING_AND_CONFORMING",
    evidence:
      "src/components/layout/notifications-bell.tsx; notifications table; " +
      "Postgres LISTEN/NOTIFY delivery.",
  },
  {
    key: "profile-switcher",
    title: "Profile switcher",
    owner: "P3-R08",
    formerlyGovernedBy: ["DC-003"],
    designSection: "7.2",
    status: "EXISTING_AND_CONFORMING",
    evidence:
      "src/components/layout/profile-switcher.tsx, mounted in the header; " +
      "ProfileFilterProvider wraps every dashboard route -- a filter, not a page, per §7.2.",
  },
  {
    key: "status-indicator",
    title: "Gateway status indicator",
    owner: "P3-R08",
    formerlyGovernedBy: ["DC-004"],
    designSection: "7.3",
    status: "EXISTING_AND_CONFORMING",
    evidence: "src/components/layout/header-status-indicator.tsx, links to /admin.",
  },
  {
    key: "overview",
    title: "Overview shell / dashboard",
    owner: "P3-R08",
    formerlyGovernedBy: ["DC-005"],
    designSection: "9 / FR-01",
    status: "EXISTING_NEEDS_REMEDIATION",
    failsCriterion: "P3-R08 AC-09",
    evidence:
      "(dashboard)/page.tsx + src/lib/dashboard/summary.ts. Scope is deliberate: its tiles " +
      "are Ops-Hub operational metrics, and the AI Money OS figures belong to P4-R11 and are " +
      "NOT added here (AC-10). FINDING: the `activeTests` tile shipped as a hard-coded 0 with " +
      "a comment awaiting DC-011/DC-012, both of which had already landed -- so the Overview " +
      "reported a measurement nobody took, and the grid distinguished 'chưa có' from a real " +
      "zero only by opacity while the aria-label read '0' either way. REMEDIATED under AC-02: " +
      "KpiValue is now number | null, activeTests is UNKNOWN, and the grid renders it as text.",
  },
  {
    key: "admin-shell",
    title: "Admin / technical shell",
    owner: "P3-R08",
    formerlyGovernedBy: ["DC-004"],
    designSection: "7.1 / FR-08",
    status: "EXISTING_AND_CONFORMING",
    evidence: "(dashboard)/admin/page.tsx behind a role guard; Hermes health badge.",
  },
  {
    key: "telegram-control-plane",
    title: "P3 Telegram / control-plane UI surfaces",
    owner: "P3-R08",
    formerlyGovernedBy: [],
    designSection: null,
    status: "NOT_IMPLEMENTED",
    evidence:
      "No Telegram surface exists. The only occurrences of the word in this repository are " +
      "the OWNER_TELEGRAM enum values shipped by P2. Built by P3-R01…R07; this record exists " +
      "so the inventory is not silently incomplete.",
  },
  {
    key: "aff-workspace-domain",
    title: "AFF Research workspace (domain content)",
    owner: "P4-R11",
    formerlyGovernedBy: ["DC-011", "DC-011b"],
    designSection: "9 / FR-03",
    status: "EXISTING_NEEDS_REMEDIATION",
    failsCriterion: "P3-R08 AC-04",
    evidence:
      "Offers is complete. Markets, Angles and Results are placeholders, and /aff/markets " +
      "ships copy promising 'Sẽ có ở follow-up story DC-011b' -- a promise made to a user in " +
      "production that existed in no register. Disposition: DEFERRED_TO:P4, carried by " +
      "P4-R11, because these are affiliate DOMAIN content and not shell.",
  },
  {
    key: "money-os-surfaces",
    title: "AI Money OS operational surfaces",
    owner: "P4-R11",
    formerlyGovernedBy: [],
    designSection: null,
    status: "NOT_IMPLEMENTED",
    evidence:
      "P2 shipped eleven live tables with no interface at all: no opportunity, signal, " +
      "cluster, score, trend, discovery-candidate or evidence surface exists.",
  },
  {
    key: "youtube-workspace",
    title: "YouTube workspace",
    owner: "UNASSIGNED",
    dispositionRecord: "CSG-02",
    formerlyGovernedBy: ["DC-012"],
    designSection: "9 / FR-04",
    status: "EXISTING_AND_CONFORMING",
    evidence:
      "Built and live. Deliberately UNASSIGNED: MASTER v3 §2.2 makes the YouTube engine a " +
      "primary objective, the active V2 roadmap has no requirement for it, and PRD_V2 " +
      "mentions it only inside PF-01 — which removed its origin types because 'V2 does not " +
      "cover' it. Carried as CSG-02, disposition OWNER_DECISION_REQUIRED. Naming a phase " +
      "here would be inventing scope.",
  },
] as const;

// ─── Derived views, so callers do not re-implement the filters ────

export function surfacesOwnedBy(owner: SurfaceOwner): readonly SurfaceRecord[] {
  return SURFACES.filter((s) => s.owner === owner);
}

export function surfacesNeedingRemediation(): readonly SurfaceRecord[] {
  return SURFACES.filter((s) => s.status === "EXISTING_NEEDS_REMEDIATION");
}

/**
 * Every story id that governed a live surface, mapped to the requirement that
 * owns it now. AC-03: after this requirement, no production surface is governed
 * only by a story id from a superseded document.
 */
export function unresolvedStoryIds(): readonly string[] {
  // A story id is UNRESOLVED only when it maps to neither a canonical
  // requirement nor a recorded disposition. `UNASSIGNED` with a CSG record is a
  // decision on file; `UNASSIGNED` without one is the hole CSG-01 described.
  const out: string[] = [];
  for (const s of SURFACES) {
    if (s.owner !== "UNASSIGNED") continue;
    if (s.dispositionRecord) continue;
    out.push(...s.formerlyGovernedBy);
  }
  return out;
}

export function storyIdOwnership(): ReadonlyMap<string, SurfaceOwner> {
  const map = new Map<string, SurfaceOwner>();
  for (const s of SURFACES) {
    for (const id of s.formerlyGovernedBy) {
      // A story id touching several surfaces resolves to the first canonical
      // owner that claims it; UNASSIGNED never overwrites a real owner.
      const existing = map.get(id);
      if (existing === undefined || existing === "UNASSIGNED") map.set(id, s.owner);
    }
  }
  return map;
}

// ─── The navigation contract (design §7.1) ────────────────────────
//
// Declared here rather than imported from nav-items.ts on purpose: a test that
// compared the implementation to itself would pass whatever the implementation
// said. This is the independent statement of what §7.1 requires, and the gate
// asserts the two agree.

export const REQUIRED_NAV_HREFS = ["/", "/tasks", "/aff", "/youtube", "/memory", "/admin"] as const;

/** §7.3 elements. Keys are component module names under `components/layout`. */
export const REQUIRED_HEADER_ELEMENTS = [
  "ProfileSwitcher",
  "HeaderSearch",
  "NotificationsBell",
  "HeaderStatusIndicator",
  "UserMenu",
] as const;

/** Every route group `(dashboard)` serves. Each must sit behind the guard. */
export const DASHBOARD_ROUTES = [
  "/",
  "/tasks",
  "/tasks/abc",
  "/aff",
  "/aff/offers",
  "/aff/markets",
  "/aff/angles",
  "/aff/results",
  "/youtube",
  "/youtube/videos",
  "/youtube/niches",
  "/youtube/ideas",
  "/youtube/production",
  "/youtube/performance",
  "/memory",
  "/search",
  "/admin",
] as const;
