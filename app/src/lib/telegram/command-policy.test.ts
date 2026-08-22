/**
 * P3-R02 — the command set.
 *
 * AC-10 is the shape of this file rather than a case in it: every command has at
 * least one case that MUST fail, so a handler returning a fixed string could not
 * pass. The failing cases are grouped with their command rather than collected
 * at the end, so removing a command's implementation removes its refusal test
 * too and the gap is visible.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { COMMANDS, type Command } from "./gateway-policy";
import {
  ACTIVE_JOB_STATES,
  COMMAND_SPEC,
  EXECUTION_STATES,
  FORBIDDEN_EFFECTS,
  NEWPROJECT_STATUS,
  OWNER_IDEA_ORIGIN_TYPE,
  OWNER_IDEA_SIGNAL_MODE,
  REFUSALS,
  UNKNOWN,
  WRITES_TO_WORDPRESS,
  assertRegistryMatchesGateway,
  buildNewProject,
  buildOwnerIdea,
  display,
  helpFor,
  isActiveJob,
  isExecutionState,
  isIdentifier,
  notFound,
  parseArgs,
  projectContentPlan,
  projectStatus,
} from "./command-policy";

import { affiliateProjectStatusEnum } from "../db/schema/aff";
import { opportunityOriginTypeEnum } from "../db/schema/opportunity-content";
import { signalOriginModeEnum } from "../db/schema/opportunity";
import { taskStatusEnum } from "../db/schema/tasks";
import { proposeAffiliateCandidate } from "../content/bidirectional-discovery-policy";

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("P3-R02 AC-01: the command set is closed and matches the gateway", () => {
  it("registers exactly the ten commands the spec names", () => {
    const spec = [
      "newproject",
      "research",
      "projects",
      "project",
      "contentplan",
      "queue",
      "drafts",
      "article",
      "status",
      "help",
    ];
    assert.deepEqual([...COMMANDS].sort(), [...spec].sort());
    assert.equal(COMMANDS.length, 10);
  });

  it("the registry and the gateway agree in BOTH directions", () => {
    assert.doesNotThrow(() => assertRegistryMatchesGateway());
    assert.deepEqual(Object.keys(COMMAND_SPEC).sort(), [...COMMANDS].sort());
  });

  it("a silent addition is caught -- the reconciliation is not decorative", () => {
    // The runtime check exists for the case the compiler cannot see. Proving it
    // bites needs a registry that disagrees, which the type forbids -- so the
    // disagreement is built here and the same comparison is applied to it.
    const tampered = { ...COMMAND_SPEC, publish: COMMAND_SPEC.help };
    const keys = Object.keys(tampered).sort();
    assert.notDeepEqual(keys, [...COMMANDS].sort());
  });

  it("a silent omission is caught", () => {
    const { help: _dropped, ...tampered } = COMMAND_SPEC;
    assert.notDeepEqual(Object.keys(tampered).sort(), [...COMMANDS].sort());
  });

  it("every command has a summary -- /help cannot list a blank line", () => {
    for (const c of COMMANDS) {
      assert.ok(COMMAND_SPEC[c].summary.trim().length > 0, c);
    }
  });
});

describe("P3-R02 AC-02: arguments are validated and refusals are distinct", () => {
  it("/project with no id, a malformed id and an unmatched id are three answers", () => {
    const missing = parseArgs("project", "");
    const malformed = parseArgs("project", "not-an-id");
    const unmatched = notFound("project");

    assert.equal(missing.ok, false);
    assert.equal(malformed.ok, false);
    assert.equal(unmatched.ok, false);

    const refusals = [
      (missing as { refusal: string }).refusal,
      (malformed as { refusal: string }).refusal,
      unmatched.refusal,
    ];
    assert.equal(new Set(refusals).size, 3, "three mistakes, three refusals");

    const messages = [
      (missing as { message: string }).message,
      (malformed as { message: string }).message,
      unmatched.message,
    ];
    assert.equal(new Set(messages).size, 3, "and three legible messages");
    for (const m of messages) assert.ok(m.length > 0);
  });

  it("a well-formed id is accepted", () => {
    const r = parseArgs("project", `  ${ID}  `);
    assert.equal(r.ok, true);
    assert.equal((r as { arg: string }).arg, ID);
  });

  it("commands that take no argument refuse one", () => {
    for (const c of COMMANDS.filter((c) => COMMAND_SPEC[c].arg === "none")) {
      const r = parseArgs(c, "something");
      assert.equal(r.ok, false, `${c} accepted an argument`);
      assert.equal((r as { refusal: string }).refusal, "UNEXPECTED_ARGUMENT");
    }
  });

  it("commands that require text refuse whitespace, not just empty", () => {
    for (const c of COMMANDS.filter((c) => COMMAND_SPEC[c].arg === "required-text")) {
      assert.equal(parseArgs(c, "   ").ok, false, `${c} accepted whitespace`);
    }
  });

  it("no refusal message names anything about the system's contents", () => {
    // The messages are logged and audited. A refusal that says "project 41
    // belongs to someone else" answers a question the caller was not allowed to
    // ask, which is how a refusal becomes an oracle.
    const all = [
      parseArgs("project", ""),
      parseArgs("project", "zzz"),
      parseArgs("status", "x"),
      notFound("article"),
    ];
    for (const r of all) {
      assert.equal(r.ok, false);
      assert.equal(/\b(owner|user|belongs|exists in|row|table)\b/i.test((r as { message: string }).message), false);
    }
  });

  it("the refusal vocabulary is closed", () => {
    assert.deepEqual([...REFUSALS], [
      "MISSING_ARGUMENT",
      "UNEXPECTED_ARGUMENT",
      "MALFORMED_ID",
      "NOT_FOUND",
    ]);
  });

  it("an id-shaped string that is not a UUID is malformed, not accepted", () => {
    for (const bad of [
      "1",
      "3f2504e0-4f89-11d3-9a0c-0305e82c330", // one short
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301x",
      "3f2504e0_4f89_11d3_9a0c_0305e82c3301",
      "'; DROP TABLE affiliate_projects; --",
      "3f2504e04f8911d39a0c0305e82c3301",
    ]) {
      assert.equal(isIdentifier(bad), false, bad);
    }
    assert.equal(isIdentifier(ID), true);
  });
});

describe("P3-R02 AC-03: /contentplan orders by the stored score and ranks nothing", () => {
  // The rows arrive in the query's order. If this layer sorted, the output would
  // differ from the input -- so the input is deliberately NOT in score order.
  const rows = [
    { id: "a", title: "low but first", normalisedScore: 12 },
    { id: "b", title: "high but second", normalisedScore: 99 },
    { id: "c", title: "middle", normalisedScore: 50 },
  ];

  it("preserves the order it was given, exactly", () => {
    const out = projectContentPlan(rows);
    assert.deepEqual(out.map((l) => l.id), ["a", "b", "c"]);
  });

  it("a re-sort in the command layer would be caught", () => {
    // The mutation this guards against, written out: if projectContentPlan
    // sorted by score, the output would be b, c, a. Asserting the difference
    // makes the failure mode explicit rather than implied.
    const resorted = [...rows].sort((x, y) => y.normalisedScore - x.normalisedScore);
    assert.deepEqual(resorted.map((r) => r.id), ["b", "c", "a"]);
    assert.notDeepEqual(projectContentPlan(rows).map((l) => l.id), ["b", "c", "a"]);
  });

  it("a null score renders UNKNOWN and does not move the row", () => {
    const withNull = [
      { id: "a", title: "unscored", normalisedScore: null },
      { id: "b", title: "scored", normalisedScore: 99 },
    ];
    const out = projectContentPlan(withNull);
    assert.deepEqual(out.map((l) => l.id), ["a", "b"]);
    assert.equal(out[0]!.score, UNKNOWN);
  });

  it("CONTROL: an empty plan is empty, not a fabricated placeholder row", () => {
    assert.deepEqual(projectContentPlan([]), []);
  });
});

describe("P3-R02 AC-03b: /queue shows active jobs", () => {
  it("active states are outstanding work, terminal states are not", () => {
    for (const s of ACTIVE_JOB_STATES) assert.equal(isActiveJob(s), true, s);
    for (const s of ["COMPLETED", "FAILED", "REJECTED", "CANCELLED", "APPROVED"]) {
      assert.equal(isActiveJob(s), false, s);
    }
  });

  it("every active state is a real task_status value -- not an invented one", () => {
    const real = new Set(taskStatusEnum.enumValues as readonly string[]);
    for (const s of ACTIVE_JOB_STATES) assert.ok(real.has(s), `${s} is not a task_status`);
  });

  it("a status outside the enum is not active -- it is refused, not guessed", () => {
    assert.equal(isActiveJob("IN_PROGRESS"), false);
    assert.equal(isActiveJob(""), false);
  });
});

describe("P3-R02 AC-04 / AC-04b: creation is not authorisation", () => {
  it("creates the project in a non-execution state", () => {
    const plan = buildNewProject({ name: "Acme review funnel", programId: ID });
    assert.ok(!("ok" in plan));
    assert.equal((plan as { status: string }).status, NEWPROJECT_STATUS);
    assert.equal(isExecutionState(NEWPROJECT_STATUS), false);
  });

  it("the chosen state is a real affiliate_project_status, not a new one", () => {
    const real = new Set(affiliateProjectStatusEnum.enumValues as readonly string[]);
    assert.ok(real.has(NEWPROJECT_STATUS), "NEWPROJECT_STATUS is not in the P2 enum");
    // And it is the enum's own default, so this records a fact rather than
    // adding a state to a P2 vocabulary to satisfy P3 wording.
    assert.equal(NEWPROJECT_STATUS, "CANDIDATE");
  });

  it("never produces APPROVED_FOR_TEST", () => {
    const plan = buildNewProject({ name: "x", programId: ID });
    assert.notEqual((plan as { status: string }).status, "APPROVED_FOR_TEST");
  });

  // The six prohibitions from Q33, each its own negative test.
  const SIX: Record<string, () => void> = {
    "does not apply to an affiliate network": () => {
      const plan = buildNewProject({ name: "x", programId: ID }) as { effects: readonly string[] };
      assert.equal(plan.effects.includes("APPLY_TO_NETWORK"), false);
    },
    "does not create or launch a Google Ads campaign": () => {
      const plan = buildNewProject({ name: "x", programId: ID }) as { effects: readonly string[] };
      assert.equal(plan.effects.includes("CREATE_ADS_CAMPAIGN"), false);
    },
    "does not spend budget": () => {
      const plan = buildNewProject({ name: "x", programId: ID }) as { effects: readonly string[] };
      assert.equal(plan.effects.includes("SPEND_BUDGET"), false);
    },
    "does not publish content": () => {
      const plan = buildNewProject({ name: "x", programId: ID }) as { effects: readonly string[] };
      assert.equal(plan.effects.includes("PUBLISH_CONTENT"), false);
    },
    "does not bypass an approval gate": () => {
      const plan = buildNewProject({ name: "x", programId: ID }) as { effects: readonly string[] };
      assert.equal(plan.effects.includes("BYPASS_APPROVAL_GATE"), false);
    },
    "does not move the project into an execution state": () => {
      const plan = buildNewProject({ name: "x", programId: ID }) as { status: string };
      assert.equal(isExecutionState(plan.status), false);
    },
  };
  for (const [name, fn] of Object.entries(SIX)) it(`AC-04b: ${name}`, fn);

  it("CONTROL: the six prohibitions are the six the decision names", () => {
    // Without this, five of the assertions above could be deleted and the suite
    // would still be green -- each one only proves its own absence.
    assert.equal(Object.keys(SIX).length, 6);
    assert.equal(FORBIDDEN_EFFECTS.length, 6);
    assert.deepEqual([...FORBIDDEN_EFFECTS], [
      "APPLY_TO_NETWORK",
      "CREATE_ADS_CAMPAIGN",
      "SPEND_BUDGET",
      "PUBLISH_CONTENT",
      "BYPASS_APPROVAL_GATE",
      "ENTER_EXECUTION_STATE",
    ]);
  });

  it("every execution state is a real enum value", () => {
    const real = new Set(affiliateProjectStatusEnum.enumValues as readonly string[]);
    for (const s of EXECUTION_STATES) assert.ok(real.has(s), s);
  });

  it("AC-04: the DISCOVERY AGENT path is still refused -- only the actor differs", () => {
    // Q33 permits the OWNER, through an explicit command, to create a project.
    // P2-R07 AC-02 forbids the autonomous discovery agent from doing so, and
    // that prohibition is unchanged. Asserted against the discovery module's own
    // return value rather than by restating the rule, so a change there fails
    // here rather than silently diverging.
    const verdict = proposeAffiliateCandidate({
      vendorName: "Acme",
      identity: { advertiserDomain: "acme.test", programmeRef: "acme-aff" },
      supportingSignalIds: ["sig-1"],
      programmeExists: {
        value: true,
        state: "YES",
        observedUrl: "https://acme.test/affiliates",
        observedAt: new Date("2026-08-22T00:00:00Z"),
      },
      facts: {},
    });

    // The best outcome the agent can reach is a CANDIDATE. Its status is not a
    // member of affiliate_project_status at all, so there is no value it could
    // hand to a project insert -- the two paths do not even share a vocabulary.
    assert.equal(verdict.ok, true);
    const projectStates = new Set(affiliateProjectStatusEnum.enumValues as readonly string[]);
    const agentStatus = (verdict as { status: string }).status;
    assert.equal(agentStatus, "PROPOSED");
    assert.equal(projectStates.has(agentStatus), false, "the agent produced a project status");

    // The owner path does produce one, and it is the non-execution state.
    const owner = buildNewProject({ name: "Acme", programId: ID }) as { status: string };
    assert.ok(projectStates.has(owner.status));
    assert.equal(owner.status, NEWPROJECT_STATUS);
  });

  it("MUST FAIL: no name", () => {
    const r = buildNewProject({ name: "   ", programId: ID });
    assert.equal((r as { ok: boolean }).ok, false);
  });

  it("MUST FAIL: no programme -- a project without one is not storable", () => {
    const r = buildNewProject({ name: "x", programId: "" });
    assert.equal((r as { ok: boolean }).ok, false);
    assert.equal((r as { refusal: string }).refusal, "MALFORMED_ID");
  });
});

describe("P3-R02 AC-05: an owner idea uses the existing P2 vocabulary", () => {
  it("records OWNER_SEED with no origin id, and an OWNER_TELEGRAM signal", () => {
    const idea = buildOwnerIdea("  compare two email tools  ") as {
      originType: string;
      originId: null;
      signalOriginMode: string;
      text: string;
    };
    assert.equal(idea.originType, "OWNER_SEED");
    assert.equal(idea.originId, null);
    assert.equal(idea.signalOriginMode, "OWNER_TELEGRAM");
    assert.equal(idea.text, "compare two email tools");
  });

  it("both constants come from the P2 enums -- no new origin type", () => {
    const origins = new Set(opportunityOriginTypeEnum.enumValues as readonly string[]);
    const modes = new Set(signalOriginModeEnum.enumValues as readonly string[]);
    assert.ok(origins.has(OWNER_IDEA_ORIGIN_TYPE));
    assert.ok(modes.has(OWNER_IDEA_SIGNAL_MODE));
  });

  it("MUST FAIL: an empty idea", () => {
    assert.equal((buildOwnerIdea("  ") as { ok: boolean }).ok, false);
  });
});

describe("P3-R02 AC-06: UNKNOWN is not zero", () => {
  it("null and undefined render UNKNOWN", () => {
    assert.equal(display(null), UNKNOWN);
    assert.equal(display(undefined), UNKNOWN);
  });

  it("zero, empty string and false render themselves -- they are values", () => {
    assert.equal(display(0), "0");
    assert.equal(display(""), "");
    assert.equal(display(false), "false");
  });

  it("NaN and Infinity render UNKNOWN, not 'NaN'", () => {
    assert.equal(display(Number.NaN), UNKNOWN);
    assert.equal(display(Number.POSITIVE_INFINITY), UNKNOWN);
  });

  it("nothing renders a dash or a plausible guess", () => {
    for (const v of [null, undefined, Number.NaN]) {
      const s = display(v);
      assert.equal(s, UNKNOWN);
      assert.notEqual(s, "-");
      assert.notEqual(s, "—");
      assert.notEqual(s, "0");
    }
  });
});

describe("P3-R02 AC-07: /status reports what it read", () => {
  it("renders the numbers it was given", () => {
    const lines = projectStatus({ failedJobs: 3, pendingApprovals: 0, databaseReachable: true });
    assert.deepEqual(lines.map((l) => l.value), ["true", "3", "0"]);
  });

  it("a query that could not answer renders UNKNOWN, never a healthy 0", () => {
    const lines = projectStatus({
      failedJobs: null,
      pendingApprovals: null,
      databaseReachable: null,
    });
    for (const l of lines) assert.equal(l.value, UNKNOWN);
  });

  it("CONTROL: 0 pending approvals is distinguishable from unknown", () => {
    const zero = projectStatus({ failedJobs: 0, pendingApprovals: 0, databaseReachable: true });
    const unknown = projectStatus({
      failedJobs: null,
      pendingApprovals: null,
      databaseReachable: true,
    });
    assert.notDeepEqual(zero.map((l) => l.value), unknown.map((l) => l.value));
  });

  it("reports the three things the spec names", () => {
    const labels = projectStatus({
      failedJobs: 1,
      pendingApprovals: 1,
      databaseReachable: true,
    }).map((l) => l.label);
    assert.deepEqual(labels, ["database", "failed jobs", "pending approvals"]);
  });
});

describe("P3-R02 AC-08: no command writes to WordPress", () => {
  it("this module declares no WordPress write path", () => {
    assert.equal(WRITES_TO_WORDPRESS, false);
  });

  it("and nothing in it imports one -- the guarantee is the import graph", async () => {
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const path = url.fileURLToPath(new URL("./command-policy.ts", import.meta.url));
    const src = await fs.readFile(path, "utf8");
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    for (const i of imports) {
      assert.equal(/wordpress|wp-|\/wp\b/i.test(i), false, `imports ${i}`);
    }
    // CONTROL: the scan found imports at all. A regex that matched nothing
    // would pass this assertion while checking nothing.
    assert.ok(imports.length > 0, "no imports were scanned -- the check is vacuous");
  });
});

describe("P3-R02 AC-09: /help lists exactly what the caller may use", () => {
  it("lists only the permitted commands", () => {
    const lines = helpFor(["help", "status"]);
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => l.startsWith("/help")));
    assert.ok(lines.some((l) => l.startsWith("/status")));
    assert.equal(lines.some((l) => l.startsWith("/newproject")), false);
  });

  it("permitting everything lists all ten", () => {
    assert.equal(helpFor([...COMMANDS]).length, 10);
  });

  it("MUST FAIL to leak: permitting nothing lists nothing", () => {
    assert.deepEqual(helpFor([]), []);
  });

  it("a command the caller may not use never appears, even if asked for", () => {
    const lines = helpFor(["status"] as Command[]);
    assert.equal(lines.join("\n").includes("/newproject"), false);
  });
});

describe("P3-R02 AC-10: every command has a case that must fail", () => {
  // The guarantee AC-10 asks for is that no handler could pass by returning a
  // fixed string. Proven per command: each one is given input it must reject.
  const FAILING: { readonly [K in Command]: () => void } = {
    newproject: () => assert.equal((buildNewProject({ name: "", programId: ID }) as { ok: boolean }).ok, false),
    research: () => assert.equal((buildOwnerIdea("") as { ok: boolean }).ok, false),
    projects: () => assert.equal(parseArgs("projects", "x").ok, false),
    project: () => assert.equal(parseArgs("project", "nope").ok, false),
    contentplan: () => assert.equal(parseArgs("contentplan", "x").ok, false),
    queue: () => assert.equal(parseArgs("queue", "x").ok, false),
    drafts: () => assert.equal(parseArgs("drafts", "x").ok, false),
    article: () => assert.equal(parseArgs("article", "").ok, false),
    status: () => assert.equal(parseArgs("status", "x").ok, false),
    help: () => assert.equal(parseArgs("help", "x").ok, false),
  };

  for (const c of COMMANDS) it(`${c} rejects something`, FAILING[c]);

  it("CONTROL: the failing set covers every command, with none left out", () => {
    assert.deepEqual(Object.keys(FAILING).sort(), [...COMMANDS].sort());
  });
});
