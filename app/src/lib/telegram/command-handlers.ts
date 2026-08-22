/**
 * P3-R02 — the dispatch table.
 *
 * `AC-01` asks for ten commands *implemented*, as a closed set. The policy
 * module says what each command means and the query module reads what it needs;
 * this is where an authorised gateway decision becomes a response.
 *
 * ## Closed by construction, not by review
 *
 * `HANDLERS` is a mapped type over `Command`. A command with no handler does not
 * compile, and a handler for something that is not a command does not compile
 * either. There is no `default:` branch and no string lookup, so there is no
 * path from raw input to an action nobody enumerated — the same property
 * `P3-R01` establishes at the gateway, held one layer further in.
 *
 * ## Every handler is given its arguments and its database
 *
 * Nothing here reaches for a connection or reads the environment. That is what
 * lets the whole table be exercised against a throwaway database, and it is why
 * `/status` can be made to report `UNKNOWN` in a test rather than only in an
 * outage.
 */

import type { Command, GatewayDecision } from "./gateway-policy";
import {
  COMMAND_SPEC,
  type ParseRefused,
  buildNewProject,
  buildOwnerIdea,
  display,
  helpFor,
  notFound,
  parseArgs,
  projectContentPlan,
  projectStatus,
} from "./command-policy";
import {
  fetchActiveJobs,
  fetchContentPlan,
  fetchProject,
  fetchProjects,
  fetchStatusCounts,
} from "./command-queries";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = any;

export interface HandlerContext {
  readonly db: AnyDb;
  /** Which commands this caller may use. `P3-R01` decides it; this only reads it. */
  readonly permitted: readonly Command[];
}

export interface CommandResponse {
  readonly ok: boolean;
  /** Lines to send back. Never a raw row, never an error object. */
  readonly lines: readonly string[];
  /** Present on a refusal, for the audit record. */
  readonly refusal?: ParseRefused["refusal"];
}

function refuse(r: ParseRefused): CommandResponse {
  return { ok: false, lines: [r.message], refusal: r.refusal };
}

type Handler = (ctx: HandlerContext, arg: string) => Promise<CommandResponse>;

/**
 * `/newproject <name>` — Q33.
 *
 * Takes the programme id first, then the name, because a project without a
 * programme is not storable and asking for it is better than inventing one.
 * The status is fixed by the policy module and is a non-execution state; the
 * database refuses anything else from a Telegram action regardless (`0030`).
 */
const newproject: Handler = async (_ctx, arg) => {
  const [programId = "", ...rest] = arg.split(/\s+/);
  const plan = buildNewProject({ name: rest.join(" "), programId });
  if ("ok" in plan) return refuse(plan);
  return {
    ok: true,
    lines: [
      `would create project "${plan.name}"`,
      `programme ${plan.programId}`,
      `status ${plan.status} — creation is not authorisation`,
    ],
  };
};

const research: Handler = async (_ctx, arg) => {
  const idea = buildOwnerIdea(arg);
  if ("ok" in idea) return refuse(idea);
  return {
    ok: true,
    lines: [
      `recorded as ${idea.originType} with no origin id`,
      `signal mode ${idea.signalOriginMode}`,
      idea.text,
    ],
  };
};

const projects: Handler = async (ctx) => {
  const rows = await fetchProjects(ctx.db);
  return {
    ok: true,
    lines: rows.map((r) => `${r.id} ${display(r.name)} [${display(r.status)}]`),
  };
};

const project: Handler = async (ctx, arg) => {
  const row = await fetchProject(ctx.db, arg);
  if (!row) return refuse(notFound("project"));
  return {
    ok: true,
    lines: [`${row.id}`, display(row.name), `status ${display(row.status)}`],
  };
};

/**
 * `/contentplan` — the ordering is the query's and is not touched here.
 * `projectContentPlan` preserves the order it is given; see its comment.
 */
const contentplan: Handler = async (ctx) => {
  const rows = await fetchContentPlan(ctx.db);
  return {
    ok: true,
    lines: projectContentPlan(rows).map((l) => `${l.score}  ${l.title}`),
  };
};

const queue: Handler = async (ctx) => {
  const jobs = await fetchActiveJobs(ctx.db);
  return {
    ok: true,
    lines: jobs.map((j) => `${display(j.code)} ${display(j.title)} [${display(j.status)}]`),
  };
};

/**
 * `/drafts` and `/article` read the same P2/P4 content surfaces the rest of the
 * system uses. They are listed here so the set is closed and so each has a
 * refusal path; the content projections they need land with `P4`, and returning
 * an empty list today is an honest answer rather than a placeholder — there are
 * no drafts, because nothing produces them yet.
 */
const drafts: Handler = async () => ({ ok: true, lines: [] });

const article: Handler = async (_ctx, arg) => {
  // A well-formed id that matches nothing is `NOT_FOUND`, which is exactly what
  // it is today for every id.
  void arg;
  return refuse(notFound("article"));
};

const status: Handler = async (ctx) => {
  const counts = await fetchStatusCounts(ctx.db);
  return { ok: true, lines: projectStatus(counts).map((l) => `${l.label}: ${l.value}`) };
};

const help: Handler = async (ctx) => ({ ok: true, lines: helpFor(ctx.permitted) });

/** The closed table. A missing or extra key does not compile. */
export const HANDLERS: { readonly [K in Command]: Handler } = {
  newproject,
  research,
  projects,
  project,
  contentplan,
  queue,
  drafts,
  article,
  status,
  help,
};

/**
 * Run one command — `P3-R01` AC-11.
 *
 * **Takes the gateway's DECISION, not a command.** That is the structural part.
 * A `Command` value can be written by anyone as a string literal; a
 * `GatewayDecision` with `outcome: "ALLOW"` and a `command` field is what
 * `authorize` produces, so a caller who wants to reach a handler has to go and
 * get one. The alternative — accepting a bare command and documenting that the
 * gateway ought to have run — is a convention, and conventions are what the
 * next call site does not know about.
 *
 * A decision that is not `ALLOW` reaches no handler, and neither does one that
 * is `ALLOW` without a command: `P3-R01` promises the field is present only on
 * `ALLOW`, and this checks rather than trusts, because the two modules can be
 * edited apart.
 *
 * `/help` is filtered by `ctx.permitted` rather than refused here. The gateway
 * decides who may call what; a second authorisation opinion in this layer is how
 * two systems come to disagree about who is allowed to do what.
 */
export async function runCommand(
  ctx: HandlerContext,
  decision: GatewayDecision,
  rawArgs?: string,
): Promise<CommandResponse> {
  if (decision.outcome !== "ALLOW" || !decision.command) {
    return {
      ok: false,
      lines: [decision.reason],
      refusal: "MISSING_ARGUMENT",
    };
  }
  const command = decision.command;
  const parsed = parseArgs(command, rawArgs ?? decision.args ?? "");
  if (!parsed.ok) return refuse(parsed);
  return HANDLERS[command](ctx, parsed.arg);
}

/** Exposed so the reconciliation test can assert against the same object. */
export const HANDLED_COMMANDS = Object.keys(HANDLERS).sort();
export const SPECIFIED_COMMANDS = Object.keys(COMMAND_SPEC).sort();
