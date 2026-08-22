/**
 * P3-R02 — the command set.
 *
 * Ten commands, closed, per the owner's spec §2. This module decides what each
 * command *means*: how its arguments are validated, what refusal a bad call
 * earns, what a display cell shows when a value is unknown, and — for
 * `/newproject` — what the command is and is not permitted to cause.
 *
 * ## The commands read P2, they do not re-model it
 *
 * `/contentplan` orders by the `P2-R03` stored opportunity score and computes
 * **no ranking of its own**. `/queue` shows active **jobs**, which is what the
 * spec says it is. An owner idea reaches the system through the *existing* P2
 * vocabulary — `signal_origin_mode = OWNER_TELEGRAM`, or a `P2-R01` opportunity
 * with origin `OWNER_SEED`. No new origin type, no parallel entity.
 *
 * ## Pure on purpose, like P3-R01
 *
 * Nothing here imports a database, a clock or an environment variable. Rows
 * arrive as plain data and leave as plain data. That is what lets the ranking
 * criterion be proven by feeding deliberately unsorted rows in and asserting
 * they come out untouched — a test that would be impossible against a function
 * that fetched its own data.
 */

import { COMMANDS, type Command } from "./gateway-policy";

// ─── The registry, reconciled against the gateway in both directions ──
//
// AC-01. The gateway resolves an update to a member of `COMMANDS`; this module
// says what each one does. Two lists that must agree is two lists that will
// drift, so the drift is made impossible to miss rather than merely unlikely:
// `COMMAND_SPEC` is keyed by `Command`, so TypeScript rejects a missing key and
// rejects an extra one, and `assertRegistryMatchesGateway` re-checks at runtime
// for the case where a `COMMANDS` entry is added and the type is widened in the
// same edit.

/** How a command's argument string is interpreted. */
export type ArgShape =
  | "none" // takes no argument; anything supplied is a refusal
  | "optional-text" // free text, may be empty
  | "required-id" // exactly one identifier
  | "required-text"; // free text, must be non-empty

export interface CommandSpec {
  readonly arg: ArgShape;
  /** One line, shown by `/help`. */
  readonly summary: string;
}

export const COMMAND_SPEC: { readonly [K in Command]: CommandSpec } = {
  newproject: {
    arg: "required-text",
    summary: "Create an affiliate project in a non-execution state",
  },
  research: { arg: "required-text", summary: "Record an owner research idea" },
  projects: { arg: "none", summary: "List affiliate projects" },
  project: { arg: "required-id", summary: "Show one affiliate project" },
  contentplan: {
    arg: "none",
    summary: "Ranked content opportunities, ordered by the stored score",
  },
  queue: { arg: "none", summary: "Show active jobs" },
  drafts: { arg: "none", summary: "List drafts awaiting review" },
  article: { arg: "required-id", summary: "Show one article" },
  status: { arg: "none", summary: "System health, failed jobs, pending approvals" },
  help: { arg: "none", summary: "List the commands you may use" },
};

/**
 * Runtime reconciliation, both directions.
 *
 * The compiler catches a key missing from `COMMAND_SPEC` only while `Command`
 * is accurate. An edit that adds to `COMMANDS` also widens `Command`, at which
 * point the mapped type demands the new key — but a `Record<string, …>` slip,
 * a cast, or a merge that resolves both sides independently all defeat that.
 * This is cheap and answers the question at the time it matters.
 */
export function assertRegistryMatchesGateway(): void {
  const spec = Object.keys(COMMAND_SPEC).sort();
  const gateway = [...COMMANDS].sort();
  if (spec.length !== gateway.length || spec.some((k, i) => k !== gateway[i])) {
    throw new Error(
      `P3-R02 AC-01: command registry does not match the gateway. ` +
        `registry=[${spec.join(",")}] gateway=[${gateway.join(",")}]`,
    );
  }
}

// ─── Refusals ─────────────────────────────────────────────────────
//
// AC-02. Distinct and legible: `/project` with no id, with a syntactically
// impossible id, and with a well-formed id that matches nothing are three
// different mistakes and earn three different answers. Collapsing them into one
// "invalid" would leave the caller unable to tell a typo from a deleted row.
//
// NOT_FOUND is deliberately absent from *parsing*: it cannot be decided without
// data, so it is a separate outcome produced by the executor. Keeping it out of
// here is what keeps this module pure.

export const REFUSALS = [
  "MISSING_ARGUMENT",
  "UNEXPECTED_ARGUMENT",
  "MALFORMED_ID",
  "NOT_FOUND",
] as const;

export type Refusal = (typeof REFUSALS)[number];

export interface ParseOk {
  readonly ok: true;
  /** Empty string when the command takes no argument. */
  readonly arg: string;
}

export interface ParseRefused {
  readonly ok: false;
  readonly refusal: Refusal;
  /**
   * Addressed to a human, and safe to log. It names what the caller did wrong
   * and never what the system contains — "no id given" is a fact about the
   * call; "project 41 belongs to another owner" would be a fact about the data.
   */
  readonly message: string;
}

export type ParseResult = ParseOk | ParseRefused;

/**
 * Identifiers are UUIDs everywhere in this schema, so anything that is not one
 * is malformed rather than absent. Checked with an explicit pattern rather than
 * a length test: `36 characters` also describes a sentence.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isIdentifier(v: string): boolean {
  return UUID.test(v);
}

export function parseArgs(command: Command, rawArgs: string): ParseResult {
  const arg = rawArgs.trim();
  const shape = COMMAND_SPEC[command].arg;

  switch (shape) {
    case "none":
      return arg === ""
        ? { ok: true, arg: "" }
        : {
            ok: false,
            refusal: "UNEXPECTED_ARGUMENT",
            message: `/${command} takes no argument`,
          };

    case "optional-text":
      return { ok: true, arg };

    case "required-text":
      return arg === ""
        ? {
            ok: false,
            refusal: "MISSING_ARGUMENT",
            message: `/${command} needs a value`,
          }
        : { ok: true, arg };

    case "required-id":
      if (arg === "") {
        return {
          ok: false,
          refusal: "MISSING_ARGUMENT",
          message: `/${command} needs an id`,
        };
      }
      return isIdentifier(arg)
        ? { ok: true, arg }
        : {
            ok: false,
            refusal: "MALFORMED_ID",
            message: `/${command}: that is not a valid id`,
          };
  }
}

/** The executor's answer when a well-formed id matches nothing. */
export function notFound(command: Command): ParseRefused {
  return {
    ok: false,
    refusal: "NOT_FOUND",
    message: `/${command}: nothing found with that id`,
  };
}

// ─── UNKNOWN is not zero ──────────────────────────────────────────
//
// AC-06. The P2 invariant reaching the presentation layer. A score nobody
// computed is not a score of 0, an evidence level nobody assessed is not the
// lowest one, and a payout nobody found is not free. Each of those substitutions
// is a fabricated fact, and the display is where fabrication is most persuasive
// because a number in a table looks measured.

export const UNKNOWN = "UNKNOWN";

/**
 * `0` and `""` are values and render as themselves. Only null and undefined are
 * absence. `NaN` is included because it is what arithmetic on a missing number
 * produces, and it would otherwise render as the string "NaN" — which looks
 * like a bug rather than like an absent input, and hides which of the two it is.
 */
export function display(value: unknown): string {
  if (value === null || value === undefined) return UNKNOWN;
  if (typeof value === "number" && !Number.isFinite(value)) return UNKNOWN;
  return String(value);
}

// ─── /contentplan orders by the stored score ──────────────────────

export interface OpportunityRow {
  readonly id: string;
  readonly title: string | null;
  /** The `P2-R03` stored score. Null when scoring has not run. */
  readonly normalisedScore: number | null;
}

export interface PlanLine {
  readonly id: string;
  readonly title: string;
  readonly score: string;
}

/**
 * AC-03. Project the rows for display **in the order they arrive**.
 *
 * The ordering is the query's — `ORDER BY` on the stored `P2-R03` score — and
 * this function must not have an opinion about it. That is not a stylistic
 * preference: a second ranking here would be a *different* score, computed from
 * whatever this layer happens to know, silently overriding the one the scoring
 * requirement exists to produce.
 *
 * Proven by feeding rows that are deliberately NOT in score order and asserting
 * the output preserves the input order exactly. A sort added here — even a
 * "harmless" tie-break — changes that output and fails.
 */
export function projectContentPlan(rows: readonly OpportunityRow[]): PlanLine[] {
  return rows.map((r) => ({
    id: r.id,
    title: display(r.title),
    score: display(r.normalisedScore),
  }));
}

// ─── /newproject: creation is not authorisation ───────────────────

/**
 * AC-04b. The canonical vocabulary has no `DRAFT`.
 *
 * The PRD says `DRAFT` / `RESEARCHING` "or an equivalent non-execution state",
 * and `affiliate_project_status` offers `CANDIDATE`, `RESEARCH`,
 * `READY_FOR_APPROVAL`, `APPROVED_FOR_TEST`, `CAMPAIGN_DRAFTED`, `TESTING`,
 * `SCALE`, `HOLD`, `STOPPED`. `CANDIDATE` is the equivalent, and it is already
 * the column default — so this mapping records an existing fact rather than
 * introducing a status. Inventing a `DRAFT` value would have added a ninth
 * state to a P2 enum to satisfy P3 wording.
 */
export const NEWPROJECT_STATUS = "CANDIDATE" as const;

/**
 * States that authorise spending, testing or publishing. `/newproject` may
 * produce none of them.
 *
 * `READY_FOR_APPROVAL` is on the list even though it authorises nothing by
 * itself: it is the state that *asks* for the approval, and a command that
 * could put a project there would let an owner idea skip straight to the
 * decision queue without the research the queue assumes has happened.
 */
export const EXECUTION_STATES = [
  "READY_FOR_APPROVAL",
  "APPROVED_FOR_TEST",
  "CAMPAIGN_DRAFTED",
  "TESTING",
  "SCALE",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export function isExecutionState(status: string): status is ExecutionState {
  return (EXECUTION_STATES as readonly string[]).includes(status);
}

/**
 * The six things `/newproject` may never do, from owner decision **Q33**.
 *
 * A closed list rather than prose, so each one is a test rather than an
 * intention. `buildNewProject` returns `effects: []` and the type makes any
 * other value unrepresentable — a handler that wanted to launch a campaign
 * would have to change this file, which is where the reviewer is looking.
 */
export const FORBIDDEN_EFFECTS = [
  "APPLY_TO_NETWORK",
  "CREATE_ADS_CAMPAIGN",
  "SPEND_BUDGET",
  "PUBLISH_CONTENT",
  "BYPASS_APPROVAL_GATE",
  "ENTER_EXECUTION_STATE",
] as const;

export type ForbiddenEffect = (typeof FORBIDDEN_EFFECTS)[number];

export interface NewProjectPlan {
  readonly name: string;
  readonly programId: string;
  readonly status: typeof NEWPROJECT_STATUS;
  /** Always empty. The type permits nothing else. */
  readonly effects: readonly never[];
}

export interface NewProjectInput {
  readonly name: string;
  readonly programId: string;
}

/**
 * AC-04 / AC-04b. Build the row `/newproject` will insert.
 *
 * `programId` is required because `affiliate_projects.program_id` is `NOT NULL`
 * and references `affiliate_programs`. A project without a programme is not a
 * project this schema can hold, so the command asks for one rather than
 * inventing a placeholder — which is the shape fabrication usually takes.
 */
export function buildNewProject(input: NewProjectInput): ParseRefused | NewProjectPlan {
  const name = input.name.trim();
  if (name === "") {
    return {
      ok: false,
      refusal: "MISSING_ARGUMENT",
      message: "/newproject needs a project name",
    };
  }
  if (!isIdentifier(input.programId)) {
    return {
      ok: false,
      refusal: "MALFORMED_ID",
      message: "/newproject needs the id of an existing affiliate programme",
    };
  }
  return {
    name,
    programId: input.programId,
    status: NEWPROJECT_STATUS,
    effects: [],
  };
}

// ─── /research records through the existing P2 vocabulary ─────────

/**
 * AC-05. An owner idea typed into Telegram is a `P2-R01` content opportunity
 * with origin `OWNER_SEED` and no origin id, carrying a signal whose
 * `signal_origin_mode` is `OWNER_TELEGRAM`.
 *
 * Both already exist in the P2 enums. This requirement adds neither, and the
 * test asserts the constants are the ones P2 declares rather than string
 * literals that merely look the same.
 */
export const OWNER_IDEA_ORIGIN_TYPE = "OWNER_SEED" as const;
export const OWNER_IDEA_SIGNAL_MODE = "OWNER_TELEGRAM" as const;

export interface OwnerIdea {
  readonly originType: typeof OWNER_IDEA_ORIGIN_TYPE;
  /** Null, and meaningfully so: an idea typed into a chat points at no source. */
  readonly originId: null;
  readonly signalOriginMode: typeof OWNER_IDEA_SIGNAL_MODE;
  readonly text: string;
}

export function buildOwnerIdea(text: string): ParseRefused | OwnerIdea {
  const t = text.trim();
  if (t === "") {
    return {
      ok: false,
      refusal: "MISSING_ARGUMENT",
      message: "/research needs something to research",
    };
  }
  return {
    originType: OWNER_IDEA_ORIGIN_TYPE,
    originId: null,
    signalOriginMode: OWNER_IDEA_SIGNAL_MODE,
    text: t,
  };
}

// ─── /queue shows active jobs ─────────────────────────────────────

/**
 * AC-03b. "Active" is the set of job states where work is outstanding.
 *
 * `WAITING_REVIEW` is active: the job is not finished and something has to
 * happen. Terminal states — `COMPLETED`, `FAILED`, `REJECTED`, `CANCELLED` —
 * are not. `IMPORTED` and `CAPTURED` are: they are jobs nobody has started.
 */
export const ACTIVE_JOB_STATES = [
  "CAPTURED",
  "QUEUED",
  "RUNNING",
  "WAITING_REVIEW",
  "REVISION_REQUESTED",
  "SYNC_DELAYED",
  "IMPORTED",
] as const;

export function isActiveJob(status: string): boolean {
  return (ACTIVE_JOB_STATES as readonly string[]).includes(status);
}

// ─── /status reports what it read ─────────────────────────────────

export interface StatusCounts {
  /** Null where the query could not answer, never 0 as a stand-in. */
  readonly failedJobs: number | null;
  readonly pendingApprovals: number | null;
  readonly databaseReachable: boolean | null;
}

export interface StatusLine {
  readonly label: string;
  readonly value: string;
}

/**
 * AC-07. Each number is rendered from what the caller read back. A query that
 * could not run yields `null`, which renders `UNKNOWN` — the one thing this may
 * not do is report a healthy-looking `0` for a question nobody answered.
 */
export function projectStatus(counts: StatusCounts): StatusLine[] {
  return [
    { label: "database", value: display(counts.databaseReachable) },
    { label: "failed jobs", value: display(counts.failedJobs) },
    { label: "pending approvals", value: display(counts.pendingApprovals) },
  ];
}

// ─── /help is scoped to the caller ────────────────────────────────

/**
 * AC-09. Lists exactly what the caller may use.
 *
 * The authorisation decision is `P3-R01`'s and is passed in; this function does
 * not re-derive it. An unauthorised caller never reaches here at all — the
 * gateway refuses first — so an empty list means "authorised, but permitted
 * nothing", which is a state worth being able to represent.
 */
export function helpFor(permitted: readonly Command[]): string[] {
  const allowed = new Set(permitted);
  return COMMANDS.filter((c) => allowed.has(c)).map(
    (c) => `/${c} — ${COMMAND_SPEC[c].summary}`,
  );
}

// ─── Nothing here writes to WordPress ─────────────────────────────

/**
 * AC-08. P3 carries consent, not content.
 *
 * There is no WordPress client in this module and no import that could reach
 * one, which is the actual guarantee. This constant exists so the criterion has
 * something to assert against, and the test that matters is the one checking
 * the module's import graph — a promise in a comment is not a control.
 */
export const WRITES_TO_WORDPRESS = false;
