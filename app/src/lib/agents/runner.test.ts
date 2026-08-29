/**
 * P4-R01 — the runner, tested on the two claims that are easy to fake.
 *
 * "The tool was refused" and "the invalid output was rejected" are both
 * satisfiable by a module that merely *returns* the right words. AC-02 and
 * AC-03 ask for something stronger, and each test below asserts the stronger
 * thing directly:
 *
 *   - the tool NEVER EXECUTED — proven by a spy that would have incremented;
 *   - the invalid output NEVER REACHED A CONSUMER — proven by asserting on the
 *     value the consumer received, not on the absence of an error.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRegistry, type AgentSpec, type ModelPolicy } from "./agent-policy";
import { callTool, runAgent, type ProviderResponse, type RunSink } from "./runner";

const AGENT: AgentSpec = {
  name: "synthetic.researcher",
  profile: "aff",
  taskClass: "RESEARCH",
  tools: ["http.get"],
  output: {
    fields: [
      { name: "summary", type: "string", required: true },
      { name: "confidence", type: "number", required: false },
    ],
  },
};

const REGISTRY = buildRegistry([AGENT]);
const POLICIES: ModelPolicy[] = [
  { taskClass: "RESEARCH", provider: "anthropic", model: "claude-opus-5", active: true },
];

const NO_USAGE = { promptTokens: null, completionTokens: null, costUsd: null };

/** Collects every row the runner writes, so exits can be asserted on. */
function recorder() {
  const rows: Parameters<RunSink>[0][] = [];
  const sink: RunSink = async (row) => {
    rows.push(row);
  };
  return { rows, sink };
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 7, 29, 10, 0, clock++));

const REQ = { agentName: AGENT.name, entityType: "opportunity", entityId: "op-1", input: {} };

// ─── AC-02 ─────────────────────────────────────────────────────────

describe("AC-02 — the tool never executes on the refusal path", () => {
  it("an undeclared tool is refused and `exec` is never reached", async () => {
    let executed = 0;
    const refusals: unknown[] = [];

    const r = await callTool(
      { registry: REGISTRY, onRefusal: async (x) => void refusals.push(x) },
      AGENT.name,
      "wordpress.publish",
      async () => {
        executed++;
        return "published";
      },
    );

    assert.equal(r.ok, false);
    // The load-bearing assertion. Everything else is a message about the tool;
    // this is about the tool.
    assert.equal(executed, 0);
    assert.equal(refusals.length, 1);
    assert.deepEqual(refusals[0], {
      agentName: AGENT.name,
      tool: "wordpress.publish",
      reason: "TOOL_NOT_DECLARED",
    });
  });

  it("an unregistered agent cannot execute any tool", async () => {
    let executed = 0;
    const r = await callTool(
      { registry: REGISTRY, onRefusal: async () => {} },
      "synthetic.impostor",
      "http.get",
      async () => {
        executed++;
        return 1;
      },
    );
    assert.equal(r.ok, false);
    assert.equal(executed, 0);
  });

  it("CONTROL — a DECLARED tool does execute", async () => {
    // Without this the two tests above pass against a `callTool` that refuses
    // unconditionally, which is a guard that protects nothing.
    let executed = 0;
    const r = await callTool(
      { registry: REGISTRY, onRefusal: async () => {} },
      AGENT.name,
      "http.get",
      async () => {
        executed++;
        return "body";
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.value, "body");
    assert.equal(executed, 1);
  });
});

// ─── AC-01 / AC-08: refusals before anything starts ────────────────

describe("AC-01/AC-08 — a refused run never started, and says so", () => {
  it("an unregistered agent is REFUSED, and the provider is never called", async () => {
    const { rows, sink } = recorder();
    let called = 0;

    const out = await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async () => {
          called++;
          return { output: {}, usage: NO_USAGE };
        },
      },
      { ...REQ, agentName: "synthetic.impostor" },
    );

    assert.equal(out.ok, false);
    assert.equal(called, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, "REFUSED");
    assert.equal(rows[0]!.errorCode, "AGENT_NOT_REGISTERED");
    // AC-06: never started means no start time.
    assert.equal(rows[0]!.startedAt, null);
    assert.equal(rows[0]!.finishedAt, null);
  });

  it("an unroutable task class is REFUSED before a model is chosen", async () => {
    const { rows, sink } = recorder();
    let called = 0;
    const out = await runAgent(
      {
        registry: REGISTRY,
        policies: [],
        sink,
        now,
        call: async () => {
          called++;
          return { output: {}, usage: NO_USAGE };
        },
      },
      REQ,
    );
    assert.equal(out.ok, false);
    assert.equal(called, 0);
    assert.equal(rows[0]!.state, "REFUSED");
    assert.equal(rows[0]!.errorCode, "NO_ACTIVE_POLICY");
    assert.equal(rows[0]!.provider, null);
  });

  it("two active policies for one class is a refusal, not a coin toss", async () => {
    const { rows, sink } = recorder();
    const out = await runAgent(
      {
        registry: REGISTRY,
        policies: [
          { taskClass: "RESEARCH", provider: "a", model: "m1", active: true },
          { taskClass: "RESEARCH", provider: "b", model: "m2", active: true },
        ],
        sink,
        now,
        call: async () => ({ output: { summary: "x" }, usage: NO_USAGE }),
      },
      REQ,
    );
    assert.equal(out.ok, false);
    assert.equal(rows[0]!.errorCode, "AMBIGUOUS_POLICY");
  });
});

// ─── AC-03 / AC-04 ─────────────────────────────────────────────────

describe("AC-03/AC-04 — invalid output reaches no consumer", () => {
  it("output that never validates is discarded, and the consumer gets nothing", async () => {
    const { rows, sink } = recorder();
    let calls = 0;

    const out = await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async (): Promise<ProviderResponse> => {
          calls++;
          return { output: { wrong: "shape" }, usage: NO_USAGE };
        },
      },
      REQ,
    );

    // The consumer is this return value. Asserting it is `ok: false` asserts
    // the criterion directly, rather than inferring it from an absent error.
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.errorCode, "REPAIR_BUDGET_EXHAUSTED");
    assert.equal("output" in out, false);

    // AC-04: bounded. First attempt plus two repairs.
    assert.equal(calls, 3);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, "FAILED");
    assert.equal(rows[0]!.errorCode, "REPAIR_BUDGET_EXHAUSTED");
    assert.ok(rows[0]!.startedAt !== null && rows[0]!.finishedAt !== null);
  });

  it("a repair that succeeds on the second attempt is accepted", async () => {
    const { rows, sink } = recorder();
    let calls = 0;
    const out = await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async () => {
          calls++;
          return calls === 1
            ? { output: { nope: 1 }, usage: NO_USAGE }
            : { output: { summary: "recovered" }, usage: NO_USAGE };
        },
      },
      REQ,
    );
    assert.equal(out.ok, true);
    assert.equal(out.ok === true && out.output.summary, "recovered");
    assert.equal(calls, 2);
    assert.equal(rows[0]!.state, "SUCCEEDED");
    assert.equal(rows[0]!.errorCode, null);
  });

  it("the repair hint names the failing field and carries no output value", async () => {
    const hints: (string | null)[] = [];
    const { sink } = recorder();
    await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async (req) => {
          hints.push(req.repairHint);
          return { output: { summary: 5 }, usage: NO_USAGE };
        },
      },
      REQ,
    );
    assert.equal(hints[0], null);
    assert.equal(hints[1], "WRONG_TYPE:summary");
    assert.equal(hints[2], "WRONG_TYPE:summary");
  });

  it("a provider that throws is FAILED, and the exception text is not persisted", async () => {
    const { rows, sink } = recorder();
    const out = await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async () => {
          const e = new Error("upstream said: Authorization: Bearer sk-ant-0123456789abcdefghij");
          e.name = "TimeoutError";
          throw e;
        },
      },
      REQ,
    );
    assert.equal(out.ok, false);
    assert.equal(rows[0]!.state, "FAILED");
    assert.equal(rows[0]!.errorCode, "PROVIDER_ERROR");
    // A provider error can echo a request header back, and headers carry keys.
    assert.equal(rows[0]!.errorMessage, "TimeoutError");
    assert.equal(String(rows[0]!.errorMessage).includes("sk-ant"), false);
  });
});

// ─── AC-05 / AC-09 ─────────────────────────────────────────────────

describe("AC-05/AC-09 — what the run row does and does not carry", () => {
  it("an unreported cost is written as NULL, not 0", async () => {
    const { rows, sink } = recorder();
    await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async () => ({ output: { summary: "x" }, usage: NO_USAGE }),
      },
      REQ,
    );
    assert.equal(rows[0]!.usage.costUsd, null);
    assert.notEqual(rows[0]!.usage.costUsd, 0);
  });

  it("a reported cost is preserved exactly", async () => {
    const { rows, sink } = recorder();
    await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async () => ({
          output: { summary: "x" },
          usage: { promptTokens: 120, completionTokens: 33, costUsd: 0.00241 },
        }),
      },
      REQ,
    );
    assert.deepEqual(rows[0]!.usage, {
      promptTokens: 120,
      completionTokens: 33,
      costUsd: 0.00241,
    });
  });

  it("a credential in model output fails the run and never reaches the consumer", async () => {
    const { rows, sink } = recorder();
    const out = await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async () => ({
          output: { summary: "sk-ant-0123456789abcdefghij" },
          usage: NO_USAGE,
        }),
      },
      REQ,
    );

    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.errorCode, "CREDENTIAL_IN_OUTPUT");
    assert.equal(rows[0]!.state, "FAILED");
    // The row names the PATH. The value must not be in `agent_runs`.
    assert.equal(rows[0]!.errorMessage, "output field $.summary matched a credential pattern");
    assert.equal(JSON.stringify(rows[0]).includes("sk-ant-0123456789"), false);
  });

  it("the credential check runs BEFORE schema validation", async () => {
    // A leaked key in an otherwise malformed output must still be caught. If
    // the order were reversed, the run would fail as REPAIR_BUDGET_EXHAUSTED
    // and the key would be re-sent to the provider twice as a repair.
    const { rows, sink } = recorder();
    let calls = 0;
    const out = await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async () => {
          calls++;
          return { output: { undeclared: "ghp_01234567890123456789abc" }, usage: NO_USAGE };
        },
      },
      REQ,
    );
    assert.equal(out.ok === false && out.errorCode, "CREDENTIAL_IN_OUTPUT");
    assert.equal(calls, 1);
    assert.equal(rows[0]!.errorCode, "CREDENTIAL_IN_OUTPUT");
  });
});

// ─── AC-10: CONTROL ────────────────────────────────────────────────

describe("AC-10 — CONTROL: a valid run succeeds and is recorded as such", () => {
  it("succeeds end to end and writes exactly one SUCCEEDED row", async () => {
    const { rows, sink } = recorder();
    const out = await runAgent(
      {
        registry: REGISTRY,
        policies: POLICIES,
        sink,
        now,
        call: async () => ({
          output: { summary: "three programmes found", confidence: 0.8 },
          usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.0001 },
        }),
      },
      REQ,
    );

    assert.equal(out.ok, true);
    assert.deepEqual(out.ok === true && out.output, {
      summary: "three programmes found",
      confidence: 0.8,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, "SUCCEEDED");
    assert.equal(rows[0]!.errorCode, null);
    assert.equal(rows[0]!.provider, "anthropic");
    assert.equal(rows[0]!.model, "claude-opus-5");
    assert.equal(rows[0]!.agentName, AGENT.name);
    assert.equal(rows[0]!.profile, "aff");
    assert.equal(rows[0]!.taskClass, "RESEARCH");
    assert.equal(rows[0]!.entityId, "op-1");
  });

  it("EVERY exit path writes exactly one row — a silent refusal is impossible", async () => {
    // AC-02 requires the refusal be recorded. A path that returned without
    // writing would make that false in exactly the cases that matter.
    const scenarios: Array<[string, Parameters<typeof runAgent>[0]["call"], string]> = [
      ["success", async () => ({ output: { summary: "x" }, usage: NO_USAGE }), "SUCCEEDED"],
      ["invalid", async () => ({ output: { bad: 1 }, usage: NO_USAGE }), "FAILED"],
      [
        "throws",
        async () => {
          throw new Error("x");
        },
        "FAILED",
      ],
      [
        "credential",
        async () => ({ output: { summary: "sk-ant-0123456789abcdefghij" }, usage: NO_USAGE }),
        "FAILED",
      ],
    ];

    for (const [label, call, expected] of scenarios) {
      const { rows, sink } = recorder();
      await runAgent({ registry: REGISTRY, policies: POLICIES, sink, now, call }, REQ);
      assert.equal(rows.length, 1, `${label} wrote ${rows.length} rows`);
      assert.equal(rows[0]!.state, expected, `${label} recorded ${rows[0]!.state}`);
    }
  });
});
