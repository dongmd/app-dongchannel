/**
 * P4-R01 — the agent framework's decisions, tested against their criteria.
 *
 * The registry here is SYNTHETIC. The production registry is empty — `P4-R02`
 * registers the first real agent — so these build their own, the same pattern
 * `owner-isolation.test.ts` uses for `P3-R01`'s allowlist. A test that could
 * only run once a business agent existed would make this requirement
 * unverifiable until the next one shipped.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_REGISTRY,
  FORBIDDEN_AGENT_WRITES,
  REPAIR_POLICY,
  RUN_STATES,
  RegistryError,
  TASK_CLASSES,
  type AgentSpec,
  type ModelPolicy,
  type RunInput,
  buildRegistry,
  buildRunRecord,
  checkTool,
  decideRepair,
  findCredential,
  isTaskClass,
  resolveAgent,
  routeModel,
  validateOutput,
} from "./agent-policy";

const NOW = new Date("2026-08-29T10:00:00Z");
const LATER = new Date("2026-08-29T10:00:05Z");

const RESEARCHER: AgentSpec = {
  name: "synthetic.researcher",
  profile: "aff",
  taskClass: "RESEARCH",
  tools: ["http.get", "db.readOpportunity"],
  output: {
    fields: [
      { name: "summary", type: "string", required: true },
      { name: "sources", type: "string[]", required: true },
      { name: "confidence", type: "number", required: false },
    ],
  },
};

const REGISTRY = buildRegistry([RESEARCHER]);

// ─── AC-01: the closed registry ────────────────────────────────────

describe("AC-01 — the registry is closed", () => {
  it("resolves a registered agent", () => {
    const r = resolveAgent(REGISTRY, "synthetic.researcher");
    assert.equal(r.ok, true);
  });

  it("refuses an agent that is not registered", () => {
    const r = resolveAgent(REGISTRY, "synthetic.impostor");
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "AGENT_NOT_REGISTERED");
  });

  it("the PRODUCTION registry holds exactly the agents their requirements define", () => {
    // This asserted `size === 0` while P4-R01 was the only shipped requirement,
    // and P4-R02 legitimately broke it by registering the first agent -- the
    // M-15 class again, a fixture pinned to a fact a later requirement exists
    // to change.
    //
    // Rewritten to the claim that does NOT expire: every registered agent is
    // one a requirement defines. An agent appearing here without one is the
    // CANONICAL_SCOPE_GAP class -- code in production that no requirement owns.
    const OWNED = new Set(["aff.project-research", "content.qa"]); // P4-R02, P4-R06
    for (const name of AGENT_REGISTRY.keys()) {
      assert.ok(OWNED.has(name), `${name} is registered but no requirement defines it`);
    }
    assert.equal(resolveAgent(AGENT_REGISTRY, "anything").ok, false);
  });

  it("refuses a duplicate agent name rather than overwriting", () => {
    // The dangerous outcome: entry two's tool list applying to entry one's name.
    assert.throws(
      () => buildRegistry([RESEARCHER, { ...RESEARCHER, tools: ["db.writeEverything"] }]),
      RegistryError,
    );
  });

  it("refuses an empty name, a bad task class, and duplicate declarations", () => {
    assert.throws(() => buildRegistry([{ ...RESEARCHER, name: "  " }]), RegistryError);
    assert.throws(
      () => buildRegistry([{ ...RESEARCHER, taskClass: "TAROT" as never }]),
      RegistryError,
    );
    assert.throws(
      () => buildRegistry([{ ...RESEARCHER, tools: ["http.get", "http.get"] }]),
      RegistryError,
    );
    assert.throws(
      () =>
        buildRegistry([
          {
            ...RESEARCHER,
            output: {
              fields: [
                { name: "x", type: "string", required: true },
                { name: "x", type: "number", required: false },
              ],
            },
          },
        ]),
      RegistryError,
    );
  });
});

// ─── AC-02: tool permission ────────────────────────────────────────

describe("AC-02 — an agent may call only its declared tools", () => {
  it("allows a declared tool", () => {
    assert.equal(checkTool(REGISTRY, "synthetic.researcher", "http.get").ok, true);
  });

  it("refuses an undeclared tool, and names it for the audit", () => {
    const d = checkTool(REGISTRY, "synthetic.researcher", "wordpress.publish");
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, "TOOL_NOT_DECLARED");
    assert.equal(d.ok === false && d.tool, "wordpress.publish");
  });

  it("refuses every tool for an unregistered agent", () => {
    const d = checkTool(REGISTRY, "synthetic.impostor", "http.get");
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, "AGENT_NOT_REGISTERED");
  });

  it("does not match a tool by prefix or case", () => {
    // "http.get" must not authorise "http.getAndPost" or "HTTP.GET".
    assert.equal(checkTool(REGISTRY, "synthetic.researcher", "http.getAndPost").ok, false);
    assert.equal(checkTool(REGISTRY, "synthetic.researcher", "HTTP.GET").ok, false);
    assert.equal(checkTool(REGISTRY, "synthetic.researcher", "http.ge").ok, false);
  });
});

// ─── AC-03: output validation ──────────────────────────────────────

describe("AC-03 — output is validated before a consumer sees it", () => {
  const schema = RESEARCHER.output;

  it("accepts valid output and returns the value INSIDE the verdict", () => {
    const v = validateOutput(schema, { summary: "ok", sources: ["a", "b"] });
    assert.equal(v.ok, true);
    // The type makes `value` unreachable without checking `ok` — that is the
    // criterion enforced by shape rather than by discipline.
    assert.deepEqual(v.ok === true && v.value, { summary: "ok", sources: ["a", "b"] });
  });

  it("rejects a missing required field", () => {
    const v = validateOutput(schema, { sources: [] });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "MISSING_REQUIRED_FIELD");
    assert.equal(v.ok === false && v.field, "summary");
  });

  it("rejects a field nobody declared", () => {
    // Accepting it would let a model widen its own contract.
    const v = validateOutput(schema, { summary: "x", sources: [], sideEffect: "publish" });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNDECLARED_FIELD");
    assert.equal(v.ok === false && v.field, "sideEffect");
  });

  it("rejects the wrong type, including the ones typeof calls a number", () => {
    assert.equal(validateOutput(schema, { summary: 1, sources: [] }).ok, false);
    assert.equal(validateOutput(schema, { summary: "x", sources: "a" }).ok, false);
    assert.equal(validateOutput(schema, { summary: "x", sources: [1] }).ok, false);
    // NaN and Infinity are numbers to `typeof` and are not answers.
    assert.equal(
      validateOutput(schema, { summary: "x", sources: [], confidence: NaN }).ok,
      false,
    );
    assert.equal(
      validateOutput(schema, { summary: "x", sources: [], confidence: Infinity }).ok,
      false,
    );
  });

  it("rejects a non-object, including an array and null", () => {
    for (const bad of [null, undefined, "text", 42, [], true]) {
      assert.equal(validateOutput(schema, bad).ok, false, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it("an absent OPTIONAL field stays absent — UNKNOWN, not a default", () => {
    // The P2 invariant reaching this layer: a missing confidence must not
    // become 0, which would be a claim the model never made.
    const v = validateOutput(schema, { summary: "x", sources: [] });
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && "confidence" in v.value, false);
  });

  it("an explicit null for an optional field is accepted and not coerced", () => {
    const v = validateOutput(schema, { summary: "x", sources: [], confidence: null });
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.value.confidence, null);
  });

  it("an explicit null for a REQUIRED field is a refusal", () => {
    const v = validateOutput(schema, { summary: null, sources: [] });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "MISSING_REQUIRED_FIELD");
  });
});

// ─── AC-04: bounded repair ─────────────────────────────────────────

describe("AC-04 — repair is bounded, and exhausting it is terminal", () => {
  const bad = validateOutput(RESEARCHER.output, {});
  const good = validateOutput(RESEARCHER.output, { summary: "x", sources: [] });

  it("the bound is versioned configuration, not a literal", () => {
    assert.equal(typeof REPAIR_POLICY.version, "number");
    assert.equal(typeof REPAIR_POLICY.maxRepairAttempts, "number");
    assert.ok(REPAIR_POLICY.maxRepairAttempts > 0);
  });

  it("accepts immediately when the output is valid", () => {
    assert.deepEqual(decideRepair(good, 0), { ok: true, action: "ACCEPT" });
  });

  it("repairs up to the bound, then gives up", () => {
    assert.deepEqual(decideRepair(bad, 0), { ok: true, action: "REPAIR", attempt: 1 });
    assert.deepEqual(decideRepair(bad, 1), { ok: true, action: "REPAIR", attempt: 2 });
    const out = decideRepair(bad, 2);
    assert.equal(out.ok, false);
    assert.equal(out.action, "GIVE_UP");
  });

  it("giving up is `ok: false` — never a pass-through of unvalidated output", () => {
    // The failure AC-04 names is a loop that runs out and shrugs the bad value
    // onward, leaving an audit trail that shows validation ran.
    const out = decideRepair(bad, 99);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "REPAIR_BUDGET_EXHAUSTED");
  });
});

// ─── AC-05 / AC-06: the run record ─────────────────────────────────

const RUN: RunInput = {
  agentName: "synthetic.researcher",
  profile: "aff",
  taskClass: "RESEARCH",
  entityType: "opportunity",
  entityId: "op-1",
  provider: "anthropic",
  model: "claude-opus-5",
  state: "SUCCEEDED",
  startedAt: NOW,
  finishedAt: LATER,
  usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.004 },
  errorCode: null,
  errorMessage: null,
};

describe("AC-05/AC-06 — the run record cannot record a lie", () => {
  it("builds a valid succeeded run", () => {
    const v = buildRunRecord(RUN, NOW);
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.record.createdAt, NOW);
  });

  it("FAILED, NEVER-STARTED and IN-FLIGHT are three distinguishable rows", () => {
    const pending = buildRunRecord(
      { ...RUN, state: "PENDING", startedAt: null, finishedAt: null, errorCode: null },
      NOW,
    );
    const running = buildRunRecord(
      { ...RUN, state: "RUNNING", startedAt: NOW, finishedAt: null },
      NOW,
    );
    const failed = buildRunRecord(
      { ...RUN, state: "FAILED", errorCode: "PROVIDER_ERROR", errorMessage: "TimeoutError" },
      NOW,
    );
    for (const v of [pending, running, failed]) assert.equal(v.ok, true);

    const states = [pending, running, failed].map((v) => (v.ok ? v.record.state : null));
    assert.deepEqual(states, ["PENDING", "RUNNING", "FAILED"]);
    // And the times differ, so the states are not the only thing separating them.
    assert.equal(pending.ok === true && pending.record.startedAt, null);
    assert.equal(running.ok === true && running.record.finishedAt, null);
    assert.ok(failed.ok === true && failed.record.finishedAt !== null);
  });

  it("refuses a never-started run that carries a start time", () => {
    // Without this, PENDING and RUNNING become the same row read two ways.
    const v = buildRunRecord({ ...RUN, state: "PENDING", finishedAt: null }, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "NEVER_STARTED_RUN_HAS_START_TIME");
  });

  it("refuses a terminal run with no finish time", () => {
    const v = buildRunRecord({ ...RUN, finishedAt: null }, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "TERMINAL_RUN_HAS_NO_FINISH_TIME");
  });

  it("refuses a running run that already finished", () => {
    const v = buildRunRecord({ ...RUN, state: "RUNNING" }, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "RUNNING_RUN_HAS_FINISH_TIME");
  });

  it("refuses a failed run that cannot say why", () => {
    const v = buildRunRecord({ ...RUN, state: "FAILED", errorCode: null }, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "FAILED_RUN_HAS_NO_ERROR_CODE");
  });

  it("refuses a succeeded run that carries an error", () => {
    const v = buildRunRecord({ ...RUN, errorCode: "SOMETHING" }, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "SUCCEEDED_RUN_CARRIES_AN_ERROR");
  });

  it("refuses a run that finished before it started", () => {
    const v = buildRunRecord({ ...RUN, startedAt: LATER, finishedAt: NOW }, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "FINISHED_BEFORE_STARTED");
  });

  it("AC-05 — an unreported cost is NULL and is NOT 0", () => {
    const v = buildRunRecord(
      { ...RUN, usage: { promptTokens: null, completionTokens: null, costUsd: null } },
      NOW,
    );
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.record.usage.costUsd, null);
    // The distinction is the point: a free run and an unreported one are
    // different facts, and a SUM that conflates them is wrong and looks right.
    assert.notEqual(v.ok === true && v.record.usage.costUsd, 0);
  });

  it("refuses a negative or non-finite usage figure", () => {
    for (const bad of [-1, NaN, Infinity]) {
      const v = buildRunRecord({ ...RUN, usage: { ...RUN.usage, costUsd: bad } }, NOW);
      assert.equal(v.ok, false, `accepted cost ${bad}`);
    }
  });

  it("refuses an unknown task class", () => {
    const v = buildRunRecord({ ...RUN, taskClass: "TAROT" as never }, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNKNOWN_TASK_CLASS");
  });

  it("every RUN_STATE is reachable through buildRunRecord", () => {
    // Otherwise a state could exist in the enum, be unbuildable, and nobody
    // would find out until a query returned nothing.
    const built = new Set<string>();
    const cases: RunInput[] = [
      { ...RUN, state: "PENDING", startedAt: null, finishedAt: null },
      { ...RUN, state: "RUNNING", finishedAt: null },
      RUN,
      { ...RUN, state: "FAILED", errorCode: "E" },
      { ...RUN, state: "REFUSED", startedAt: null, finishedAt: null, errorCode: "E" },
    ];
    for (const c of cases) {
      const v = buildRunRecord(c, NOW);
      assert.equal(v.ok, true, `${c.state} could not be built`);
      if (v.ok) built.add(v.record.state);
    }
    assert.deepEqual([...built].sort(), [...RUN_STATES].sort());
  });
});

// ─── AC-07: forbidden writes ───────────────────────────────────────

describe("AC-07 — the Sources of Truth an agent may never write", () => {
  it("names the writes that would let an agent manufacture an owner's fact", () => {
    const f = FORBIDDEN_AGENT_WRITES.join(" | ");
    assert.match(f, /INSERT article_approvals/);
    assert.match(f, /article_publish_intents/);
    assert.match(f, /INSERT audit_events/);
    assert.match(f, /dc_verified/);
    assert.match(f, /WORDPRESS write/);
    assert.equal(new Set(FORBIDDEN_AGENT_WRITES).size, FORBIDDEN_AGENT_WRITES.length);
  });
});

// ─── AC-08: model routing ──────────────────────────────────────────

describe("AC-08 — routing is table-driven", () => {
  const policies: ModelPolicy[] = [
    { taskClass: "RESEARCH", provider: "anthropic", model: "claude-opus-5", active: true },
    { taskClass: "RESEARCH", provider: "anthropic", model: "claude-sonnet-5", active: false },
    { taskClass: "WRITING", provider: "anthropic", model: "claude-opus-5", active: true },
  ];

  it("routes a task class to its single active policy", () => {
    const r = routeModel(policies, "RESEARCH");
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.model, "claude-opus-5");
  });

  it("ignores inactive rows", () => {
    const r = routeModel(
      [{ taskClass: "QA", provider: "x", model: "y", active: false }],
      "QA",
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "NO_ACTIVE_POLICY");
  });

  it("refuses ambiguity rather than taking the first row", () => {
    // First-match would make routing depend on row order, so the same task
    // would quietly change model when a row was edited.
    const r = routeModel(
      [
        { taskClass: "QA", provider: "a", model: "m1", active: true },
        { taskClass: "QA", provider: "b", model: "m2", active: true },
      ],
      "QA",
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "AMBIGUOUS_POLICY");
  });

  it("every task class is routable, and none is a typo", () => {
    for (const tc of TASK_CLASSES) {
      assert.equal(isTaskClass(tc), true);
      const r = routeModel([{ taskClass: tc, provider: "p", model: "m", active: true }], tc);
      assert.equal(r.ok, true, `${tc} did not route`);
    }
    assert.equal(isTaskClass("RESEARCHING"), false);
    assert.equal(isTaskClass("research"), false);
  });
});

// ─── AC-09: credentials ────────────────────────────────────────────

describe("AC-09 — a credential never travels in output or a run row", () => {
  it("finds a credential nested in an object or an array", () => {
    assert.equal(findCredential({ a: { b: "sk-ant-0123456789abcdefghij" } }), "$.a.b");
    assert.equal(findCredential({ xs: ["fine", "ghp_01234567890123456789abc"] }), "$.xs[1]");
    assert.equal(
      findCredential({ k: "-----BEGIN RSA PRIVATE KEY-----\nabc" }),
      "$.k",
    );
    assert.equal(findCredential({ t: "1234567890:AA" + "x".repeat(33) }), "$.t");
  });

  it("returns the PATH, never the value", () => {
    const secret = "sk-ant-0123456789abcdefghij";
    const hit = findCredential({ token: secret });
    assert.equal(hit, "$.token");
    // A function that returned the secret so a caller could log "found X"
    // would be the leak it was written to prevent.
    assert.ok(hit !== null && !hit.includes(secret));
  });

  it("does not fire on ordinary prose", () => {
    // A check that flagged everything would be relaxed, and then catch nothing.
    assert.equal(findCredential({ summary: "The sk-ill level required is high." }), null);
    assert.equal(findCredential({ n: 42, b: true, xs: ["a", "b"] }), null);
    assert.equal(findCredential("a normal sentence about API keys"), null);
    assert.equal(findCredential(null), null);
  });
});

// ─── AC-10: CONTROL ────────────────────────────────────────────────

describe("AC-10 — CONTROL: the framework is not one that refuses everything", () => {
  it("a correctly-declared agent with valid output SUCCEEDS end to end", () => {
    // Without this, every assertion above is satisfied by a module whose every
    // function returns a refusal — and the suite would be green and worthless.
    const agent = resolveAgent(REGISTRY, "synthetic.researcher");
    assert.equal(agent.ok, true);

    const tool = checkTool(REGISTRY, "synthetic.researcher", "http.get");
    assert.equal(tool.ok, true);

    const out = validateOutput(RESEARCHER.output, {
      summary: "found three programmes",
      sources: ["https://example.test/a"],
      confidence: 0.7,
    });
    assert.equal(out.ok, true);

    assert.deepEqual(decideRepair(out, 0), { ok: true, action: "ACCEPT" });

    const route = routeModel(
      [{ taskClass: "RESEARCH", provider: "anthropic", model: "claude-opus-5", active: true }],
      "RESEARCH",
    );
    assert.equal(route.ok, true);

    const run = buildRunRecord(RUN, NOW);
    assert.equal(run.ok, true);

    assert.equal(findCredential(out.ok === true ? out.value : null), null);
  });
});
