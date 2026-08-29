/**
 * P4-R01 — the agent framework's decisions, as data.
 *
 * An agent is a model given tools and asked to produce structured output. Three
 * things about that are dangerous, and this module is where each is decided
 * rather than hoped for:
 *
 *   1. an agent may call only the tools it declared (AC-02);
 *   2. output nothing has validated reaches no consumer (AC-03);
 *   3. no agent writes to a Source of Truth another phase owns (AC-07).
 *
 * ## Pure, like `command-policy` and `two-step-policy`
 *
 * Nothing here imports a database, a clock, an environment variable or a model
 * provider. `now` is always a parameter. Every decision is a function from
 * plain data to plain data, which is what lets the refusals be proven by
 * feeding an over-permissioned request in and asserting the tool never ran —
 * a test that is impossible against a function that reaches for its own
 * dependencies.
 *
 * ## Why the registry is a runtime value and not a literal union
 *
 * `P3-R01`'s ten commands are a mapped type over a `Command` union, because the
 * ten commands were specified when that module was written; TypeScript could
 * therefore reject a missing key. **No agent is specified yet.** `P4-R02`
 * through `P4-R08` are the requirements that define them, and this requirement
 * is only the framework they run on. So `AGENT_REGISTRY` ships with **zero
 * business agents** and `buildRegistry` enforces the closed-set properties at
 * construction. Inventing a union of six agent names here to make the types
 * prettier would be writing `P4-R02`'s scope inside `P4-R01`, and the owner
 * ruled that out in terms: no general agent platform built wider than the
 * requirement.
 *
 * The registry's own tests use SYNTHETIC agents, the pattern
 * `owner-isolation.test.ts` already established for `P3-R01`.
 */

// ─── Task classes ──────────────────────────────────────────────────
//
// AC-08. Model routing is keyed on a task CLASS, not on an agent and not on a
// call site, so changing which model serves a class is a row in
// `model_policies` rather than an edit and a deploy.
//
// The six classes are not invented here: they are the capabilities the P4
// dependency graph already names -- P4-R02 research, the CONTENT_AGENT
// decomposition into P4-R03 strategy / P4-R04 evidence / P4-R05 writing,
// P4-R06 QA and P4-R08 publishing.

export const TASK_CLASSES = [
  "RESEARCH",
  "STRATEGY",
  "EVIDENCE",
  "WRITING",
  "QA",
  "PUBLISHING",
] as const;

export type TaskClass = (typeof TASK_CLASSES)[number];

const TASK_CLASS_SET: ReadonlySet<string> = new Set(TASK_CLASSES);

export function isTaskClass(v: unknown): v is TaskClass {
  return typeof v === "string" && TASK_CLASS_SET.has(v);
}

// ─── The registry ──────────────────────────────────────────────────

/**
 * What an agent declares about itself. All three fields are the subject of an
 * acceptance criterion: the profile it runs under, the tools it may call
 * (AC-02) and the shape of its output (AC-03).
 */
export interface AgentSpec {
  readonly name: string;
  /** Ops Hub profile slug. `aff` and `yt` are the two that exist. */
  readonly profile: string;
  readonly taskClass: TaskClass;
  /** AC-02. The CLOSED set of tools this agent may call. */
  readonly tools: readonly string[];
  /** AC-03. The field contract its output must satisfy. */
  readonly output: OutputSchema;
}

/**
 * A deliberately small schema language.
 *
 * It exists to answer one question -- "may a consumer see this?" -- and a
 * consumer that needs richer validation than this has a requirement of its own.
 * Reaching for a general schema library here would pull a dependency into a
 * module whose entire value is that it imports nothing.
 */
export interface OutputSchema {
  readonly fields: readonly OutputField[];
}

export interface OutputField {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "string[]";
  /**
   * When false, the field may be absent or `null`.
   *
   * `null` is a real answer meaning UNKNOWN, and it is not the same as a field
   * the model forgot. The P2 invariant reaches this layer too: an unknown value
   * is never silently replaced with `0` or `""`.
   */
  readonly required: boolean;
}

export type Registry = ReadonlyMap<string, AgentSpec>;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * AC-01. Build the closed registry, refusing anything that would make it
 * unenforceable later.
 *
 * The checks are here rather than at call time because a registry is built once
 * and consulted thousands of times: a duplicate name that silently overwrites
 * an entry would give an agent someone else's tool permissions, and nothing
 * downstream could detect it.
 */
export function buildRegistry(specs: readonly AgentSpec[]): Registry {
  const map = new Map<string, AgentSpec>();

  for (const spec of specs) {
    if (!spec.name.trim()) {
      throw new RegistryError("an agent was registered with an empty name");
    }
    if (map.has(spec.name)) {
      // Silent overwrite is the dangerous outcome: the second entry's tool list
      // would apply to the first entry's name.
      throw new RegistryError(`duplicate agent name: ${spec.name}`);
    }
    if (!isTaskClass(spec.taskClass)) {
      throw new RegistryError(
        `agent ${spec.name} declares task class ${String(spec.taskClass)}, which is not a task class`,
      );
    }
    if (new Set(spec.tools).size !== spec.tools.length) {
      throw new RegistryError(`agent ${spec.name} declares a duplicate tool`);
    }
    if (new Set(spec.output.fields.map((f) => f.name)).size !== spec.output.fields.length) {
      throw new RegistryError(`agent ${spec.name} declares a duplicate output field`);
    }
    map.set(spec.name, spec);
  }

  return map;
}

/**
 * The production registry.
 *
 * **Empty, and correctly so.** `P4-R01` is the framework; no agent has been
 * specified yet. `P4-R02` adds the first entry. An empty registry is not an
 * unfinished one — combined with `resolveAgent` below it means every attempt to
 * run an agent today is refused, which is exactly what AC-01 asks for.
 */
export const AGENT_REGISTRY: Registry = buildRegistry([]);

/**
 * AC-01. An agent absent from the registry cannot be run at all.
 *
 * Returns the spec or a refusal — never `undefined`, so a caller cannot reach
 * the "run it anyway" branch by forgetting a null check.
 */
export type AgentResolution =
  | { readonly ok: true; readonly spec: AgentSpec }
  | { readonly ok: false; readonly reason: "AGENT_NOT_REGISTERED" };

export function resolveAgent(registry: Registry, name: string): AgentResolution {
  const spec = registry.get(name);
  return spec ? { ok: true, spec } : { ok: false, reason: "AGENT_NOT_REGISTERED" };
}

// ─── AC-02: tool permission, decided before the call ───────────────

export type ToolDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "AGENT_NOT_REGISTERED" | "TOOL_NOT_DECLARED";
      /** Named so a refusal can be audited. Never carries arguments. */
      readonly tool: string;
    };

/**
 * May this agent call this tool?
 *
 * Called BEFORE the tool, never after. The distinction is the whole criterion:
 * a check that runs after the call has already let the side effect happen, and
 * an audit line saying "refused" would then be false.
 *
 * Tool ARGUMENTS are deliberately not a parameter. This answers "may you call
 * it", and a function that also inspected arguments would tempt a caller into
 * treating it as general input validation, which it is not.
 */
export function checkTool(
  registry: Registry,
  agentName: string,
  tool: string,
): ToolDecision {
  const resolved = resolveAgent(registry, agentName);
  if (!resolved.ok) {
    return { ok: false, reason: "AGENT_NOT_REGISTERED", tool };
  }
  if (!resolved.spec.tools.includes(tool)) {
    return { ok: false, reason: "TOOL_NOT_DECLARED", tool };
  }
  return { ok: true };
}

// ─── AC-07: Sources of Truth an agent may never write ──────────────
//
// The same shape as `P3-R02`'s FORBIDDEN_EFFECTS, and for the same reason: a
// boundary written as a sentence in a design document is a boundary nothing
// enforces. Each entry is a write that would let an agent manufacture a fact
// the owner is supposed to be the only source of.

export const FORBIDDEN_AGENT_WRITES = [
  // The central non-negotiable. An approval is created by a confirmed owner
  // callback in P3-R04, and by nothing else. An agent that could insert one
  // could approve its own output.
  "INSERT article_approvals",
  // Consuming a publish intent is P4-R08's act, performed once, under
  // P4-R09's idempotency rule. Any other agent marking one CONSUMED would
  // silently discard a publish.
  "UPDATE article_publish_intents SET state = 'CONSUMED'",
  // Audit is append-only and has exactly one writer: P3-R06's `recordAudit`.
  // An agent writing the table directly could omit the entry for its own act.
  "INSERT audit_events",
  // Setting dc_verified from an agent would make "approval = verification"
  // true in code, which is the project's oldest rule against.
  "UPDATE dc_verified",
  // A second approval or publish path is how one queue becomes two that
  // disagree; TDD-P3-HANDOFF freezes both for P4.
  "INSERT telegram_pending_actions",
  // Publishing to WordPress is P4-R08's, through its signed path. No other
  // agent reaches the CMS.
  "WORDPRESS write",
] as const;

export type ForbiddenWrite = (typeof FORBIDDEN_AGENT_WRITES)[number];

// ─── AC-03: output validation, before any consumer ─────────────────

export type OutputVerdict =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string; readonly field: string | null };

/**
 * Validate one agent output against its declared schema.
 *
 * Returns a verdict rather than throwing, and the valid value is returned
 * INSIDE the verdict rather than alongside it. A caller therefore cannot reach
 * the value without having looked at `ok` — the type will not let it. That is
 * AC-03 enforced by shape rather than by discipline.
 */
export function validateOutput(
  schema: OutputSchema,
  raw: unknown,
): OutputVerdict {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "NOT_AN_OBJECT", field: null };
  }

  const obj = raw as Record<string, unknown>;
  const known = new Set(schema.fields.map((f) => f.name));

  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      // A field nobody declared is a field nobody validated. Accepting it would
      // let a model widen its own contract.
      return { ok: false, reason: "UNDECLARED_FIELD", field: key };
    }
  }

  for (const field of schema.fields) {
    const present = Object.prototype.hasOwnProperty.call(obj, field.name);
    const value = present ? obj[field.name] : undefined;

    if (!present || value === null || value === undefined) {
      if (field.required) {
        return { ok: false, reason: "MISSING_REQUIRED_FIELD", field: field.name };
      }
      continue; // absent optional field stays absent: UNKNOWN, not a default
    }

    if (!matchesType(value, field.type)) {
      return { ok: false, reason: "WRONG_TYPE", field: field.name };
    }
  }

  return { ok: true, value: obj };
}

function matchesType(value: unknown, type: OutputField["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      // NaN and Infinity are numbers to `typeof` and are not answers.
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

// ─── AC-04: bounded repair ─────────────────────────────────────────

/**
 * Versioned, so a change to the bound is a visible change to configuration
 * rather than an edited literal at a call site. Same shape as `P3-R07`'s
 * `PREVIEW_TTL_CONFIG`, for the same reason.
 */
export const REPAIR_POLICY = {
  version: 1,
  /** Attempts to repair invalid output BEYOND the first try. */
  maxRepairAttempts: 2,
} as const;

export type RepairDecision =
  | { readonly ok: true; readonly action: "ACCEPT" }
  | { readonly ok: true; readonly action: "REPAIR"; readonly attempt: number }
  | { readonly ok: false; readonly action: "GIVE_UP"; readonly reason: "REPAIR_BUDGET_EXHAUSTED" };

/**
 * What to do after an output verdict.
 *
 * Exhausting the budget is a TERMINAL, RECORDED outcome — `ok: false`. It is
 * never a pass-through of unvalidated output, which is the failure AC-04 names:
 * a retry loop that runs out and then shrugs the bad value onward is worse than
 * no validation at all, because the audit trail shows a validation step ran.
 */
export function decideRepair(
  verdict: OutputVerdict,
  attemptsSoFar: number,
  policy: typeof REPAIR_POLICY = REPAIR_POLICY,
): RepairDecision {
  if (verdict.ok) {
    return { ok: true, action: "ACCEPT" };
  }
  if (attemptsSoFar >= policy.maxRepairAttempts) {
    return { ok: false, action: "GIVE_UP", reason: "REPAIR_BUDGET_EXHAUSTED" };
  }
  return { ok: true, action: "REPAIR", attempt: attemptsSoFar + 1 };
}

// ─── AC-05 / AC-06: the run record ─────────────────────────────────

/**
 * AC-06. Four states, and the three distinctions the criterion demands:
 * a run that FAILED, one that NEVER STARTED, and one still IN FLIGHT are three
 * different rows, not one row read three ways.
 */
export const RUN_STATES = [
  "PENDING", // created, not yet started — never started
  "RUNNING", // in flight
  "SUCCEEDED",
  "FAILED", // started and failed
  "REFUSED", // never started: the framework refused it (AC-01/AC-02)
] as const;

export type RunState = (typeof RUN_STATES)[number];

export interface RunUsage {
  /**
   * `null` means the provider did not report it.
   *
   * NOT `0`. A zero-cost run and an unreported cost are different facts, and
   * summing a column where the second has been written as the first produces a
   * total that is wrong and looks right. This is the P2 UNKNOWN invariant
   * arriving in the agent layer.
   */
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: number | null;
}

export interface RunInput {
  readonly agentName: string;
  readonly profile: string;
  readonly taskClass: TaskClass;
  readonly entityType: string;
  readonly entityId: string;
  readonly provider: string;
  readonly model: string;
  readonly state: RunState;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly usage: RunUsage;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface RunRecord extends RunInput {
  readonly createdAt: Date;
}

export type RunVerdict =
  | { readonly ok: true; readonly record: RunRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * AC-05/AC-06. Build the row, refusing states that would record a lie.
 *
 * The refusals matter more than the fields. A `SUCCEEDED` run with no finish
 * time, or a `FAILED` run with no error code, is a row that satisfies a schema
 * and answers no question — and the query that later asks "why did this fail"
 * gets `NULL` and cannot tell a missing reason from a run that had none.
 */
export function buildRunRecord(input: RunInput, now: Date): RunVerdict {
  if (!isTaskClass(input.taskClass)) {
    return { ok: false, reason: "UNKNOWN_TASK_CLASS" };
  }

  const started = input.startedAt !== null;
  const finished = input.finishedAt !== null;

  switch (input.state) {
    case "PENDING":
    case "REFUSED":
      // Neither ever ran. A start time here would make "never started"
      // indistinguishable from "started", which is precisely AC-06.
      if (started) return { ok: false, reason: "NEVER_STARTED_RUN_HAS_START_TIME" };
      if (finished) return { ok: false, reason: "NEVER_STARTED_RUN_HAS_FINISH_TIME" };
      break;
    case "RUNNING":
      if (!started) return { ok: false, reason: "RUNNING_RUN_HAS_NO_START_TIME" };
      if (finished) return { ok: false, reason: "RUNNING_RUN_HAS_FINISH_TIME" };
      break;
    case "SUCCEEDED":
    case "FAILED":
      if (!started) return { ok: false, reason: "TERMINAL_RUN_HAS_NO_START_TIME" };
      if (!finished) return { ok: false, reason: "TERMINAL_RUN_HAS_NO_FINISH_TIME" };
      break;
  }

  if (started && finished && input.finishedAt! < input.startedAt!) {
    return { ok: false, reason: "FINISHED_BEFORE_STARTED" };
  }

  if (input.state === "FAILED" && !input.errorCode) {
    return { ok: false, reason: "FAILED_RUN_HAS_NO_ERROR_CODE" };
  }
  if (input.state === "REFUSED" && !input.errorCode) {
    return { ok: false, reason: "REFUSED_RUN_HAS_NO_ERROR_CODE" };
  }
  if (input.state === "SUCCEEDED" && (input.errorCode || input.errorMessage)) {
    return { ok: false, reason: "SUCCEEDED_RUN_CARRIES_AN_ERROR" };
  }

  for (const [field, v] of Object.entries(input.usage)) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      return { ok: false, reason: `USAGE_NOT_A_QUANTITY:${field}` };
    }
  }

  return { ok: true, record: { ...input, createdAt: now } };
}

// ─── AC-08: model routing ──────────────────────────────────────────

export interface ModelPolicy {
  readonly taskClass: TaskClass;
  readonly provider: string;
  readonly model: string;
  readonly active: boolean;
}

export type RouteDecision =
  | { readonly ok: true; readonly provider: string; readonly model: string }
  | { readonly ok: false; readonly reason: "NO_ACTIVE_POLICY" | "AMBIGUOUS_POLICY" };

/**
 * Which model serves this task class?
 *
 * Two active policies for one class is a refusal, not a first-match. Picking
 * the first would make routing depend on row order, so the same task would
 * quietly change model when a row was edited — and nothing would report it.
 */
export function routeModel(
  policies: readonly ModelPolicy[],
  taskClass: TaskClass,
): RouteDecision {
  const active = policies.filter((p) => p.active && p.taskClass === taskClass);
  if (active.length === 0) return { ok: false, reason: "NO_ACTIVE_POLICY" };
  if (active.length > 1) return { ok: false, reason: "AMBIGUOUS_POLICY" };
  const chosen = active[0]!;
  return { ok: true, provider: chosen.provider, model: chosen.model };
}

// ─── AC-09: credentials never travel into output or into a run row ──

/**
 * Patterns for the credential shapes this project actually holds.
 *
 * Deliberately conservative: this is a last line of defence, not the control.
 * The control is that credentials live in the environment and are never passed
 * to a model at all. A regex that tried to catch every possible secret would
 * produce false positives, get relaxed, and then catch nothing.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}/, // Anthropic
  /\bghp_[A-Za-z0-9]{20,}/, // GitHub
  /\bAIza[A-Za-z0-9_-]{20,}/, // Google
  /\b\d{6,}:AA[A-Za-z0-9_-]{30,}/, // Telegram bot token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * Does this value carry something that looks like a credential?
 *
 * Returns the PATH to the offending field, never the value. A function that
 * returned the secret so the caller could log "found X" would be the leak it
 * was written to prevent.
 */
export function findCredential(value: unknown, path = "$"): string | null {
  if (typeof value === "string") {
    return SECRET_PATTERNS.some((p) => p.test(value)) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findCredential(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = findCredential(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}
