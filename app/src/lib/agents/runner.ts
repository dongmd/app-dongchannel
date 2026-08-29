/**
 * P4-R01 — the only path on which an agent runs.
 *
 * ## No `server-only`, deliberately
 *
 * This module holds no live handle: the provider call, the run sink and the
 * clock are all injected. `server-only` would make it unimportable from the
 * test runner while protecting nothing, and the marker belongs on whatever
 * module later wires the real provider and the real database — the same split
 * `retry-policy.ts` and `sync-worker.ts` already use here.
 *
 * That is not a concession to testability. It is the reason the refusals can be
 * proven at all: a runner that reached for its own database could be shown to
 * refuse one particular call, never to have no path that writes.
 *
 * `agent-policy.ts` decides; this executes those decisions and is the single
 * place where a tool is actually invoked and an output actually reaches a
 * consumer. That single-path property is what makes AC-02 and AC-03
 * *structural* rather than conventional: there is no second way to call a tool,
 * so "an agent may call only its declared tools" is not a rule anyone has to
 * remember.
 *
 * ## The control-plane boundary, stated as code
 *
 * The owner's constraint for this requirement: an agent never fabricates an
 * owner approval, never publishes to WordPress directly, never creates a
 * parallel approval record or an alternate publish queue, and never writes
 * `audit_events` except through `P3-R06`'s canonical writer.
 *
 * The load-bearing property here is narrower and stronger than any of those
 * sentences: **model output is data, never a command.** Nothing a model returns
 * is dispatched, evaluated, or used to select a code path. It is validated
 * against a declared schema and handed back to the caller as a plain object.
 * A tool call is chosen by the CALLER from the agent's declared list — never by
 * a string the model produced naming a tool. That is why an agent cannot reach
 * `article_approvals`: not because it is told not to, but because there is no
 * mechanism by which its output could name a destination.
 */

import {
  type AgentSpec,
  type Registry,
  type RunState,
  type RunUsage,
  type TaskClass,
  checkTool,
  decideRepair,
  findCredential,
  resolveAgent,
  routeModel,
  validateOutput,
  type ModelPolicy,
  REPAIR_POLICY,
} from "./agent-policy";

/** What the framework asks a provider for. Deliberately minimal. */
export interface ProviderRequest {
  readonly provider: string;
  readonly model: string;
  readonly agent: AgentSpec;
  readonly input: Record<string, unknown>;
  /** Set when re-asking after invalid output; names the failing field only. */
  readonly repairHint: string | null;
}

export interface ProviderResponse {
  readonly output: unknown;
  readonly usage: RunUsage;
}

/** Injected, so the whole runner is testable without a network. */
export interface ProviderCall {
  (req: ProviderRequest): Promise<ProviderResponse>;
}

/** Injected. Persists one row; the caller owns the transaction. */
export interface RunSink {
  (row: {
    agentName: string;
    profile: string;
    taskClass: TaskClass;
    entityType: string;
    entityId: string;
    provider: string | null;
    model: string | null;
    state: RunState;
    startedAt: Date | null;
    finishedAt: Date | null;
    usage: RunUsage;
    errorCode: string | null;
    errorMessage: string | null;
  }): Promise<void>;
}

export interface RunRequest {
  readonly agentName: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly input: Record<string, unknown>;
}

export type RunOutcome =
  | { readonly ok: true; readonly output: Record<string, unknown> }
  | { readonly ok: false; readonly errorCode: string; readonly detail: string | null };

const NO_USAGE: RunUsage = { promptTokens: null, completionTokens: null, costUsd: null };

/**
 * Run one agent.
 *
 * Every exit records a row. A refusal that left no trace would make "the
 * refusal is recorded" (AC-02) false in exactly the cases that matter.
 */
export async function runAgent(
  deps: {
    registry: Registry;
    policies: readonly ModelPolicy[];
    call: ProviderCall;
    sink: RunSink;
    now: () => Date;
  },
  req: RunRequest,
): Promise<RunOutcome> {
  const { registry, policies, call, sink, now } = deps;

  // ---- AC-01. Unregistered agents never start. Recorded as REFUSED, which is
  // ---- a distinct state from FAILED: nothing ran.
  const resolved = resolveAgent(registry, req.agentName);
  if (!resolved.ok) {
    await sink({
      agentName: req.agentName,
      profile: "UNKNOWN",
      taskClass: "RESEARCH",
      entityType: req.entityType,
      entityId: req.entityId,
      provider: null,
      model: null,
      state: "REFUSED",
      startedAt: null,
      finishedAt: null,
      usage: NO_USAGE,
      errorCode: "AGENT_NOT_REGISTERED",
      errorMessage: `no agent named ${req.agentName} is registered`,
    });
    return { ok: false, errorCode: "AGENT_NOT_REGISTERED", detail: null };
  }

  const spec = resolved.spec;

  const base = {
    agentName: spec.name,
    profile: spec.profile,
    taskClass: spec.taskClass,
    entityType: req.entityType,
    entityId: req.entityId,
  };

  // ---- AC-08. Routing before starting: an unroutable task never ran either.
  const route = routeModel(policies, spec.taskClass);
  if (!route.ok) {
    await sink({
      ...base,
      provider: null,
      model: null,
      state: "REFUSED",
      startedAt: null,
      finishedAt: null,
      usage: NO_USAGE,
      errorCode: route.reason,
      errorMessage: `no single active model policy for task class ${spec.taskClass}`,
    });
    return { ok: false, errorCode: route.reason, detail: null };
  }

  const startedAt = now();
  let usage: RunUsage = NO_USAGE;
  let attempts = 0;
  let repairHint: string | null = null;

  // ---- AC-04. A bounded loop. There is no branch out of it that carries
  // ---- unvalidated output forward.
  for (;;) {
    let response: ProviderResponse;
    try {
      response = await call({
        provider: route.provider,
        model: route.model,
        agent: spec,
        input: req.input,
        repairHint,
      });
    } catch (e) {
      await sink({
        ...base,
        provider: route.provider,
        model: route.model,
        state: "FAILED",
        startedAt,
        finishedAt: now(),
        usage,
        errorCode: "PROVIDER_ERROR",
        // The message is the class of failure, not the exception text: a
        // provider error can echo a request header back, and headers carry keys.
        errorMessage: e instanceof Error ? e.name : "unknown provider failure",
      });
      return { ok: false, errorCode: "PROVIDER_ERROR", detail: null };
    }

    usage = response.usage;

    // ---- AC-09. Before anything else looks at this output. A model that has
    // ---- been fed or has guessed a credential must not have it persisted into
    // ---- `agent_runs` or handed to a consumer.
    const leak = findCredential(response.output);
    if (leak) {
      await sink({
        ...base,
        provider: route.provider,
        model: route.model,
        state: "FAILED",
        startedAt,
        finishedAt: now(),
        usage,
        errorCode: "CREDENTIAL_IN_OUTPUT",
        // The PATH, never the value.
        errorMessage: `output field ${leak} matched a credential pattern`,
      });
      return { ok: false, errorCode: "CREDENTIAL_IN_OUTPUT", detail: leak };
    }

    // ---- AC-03. The consumer is the `return` below, and it is unreachable
    // ---- except through this verdict.
    const verdict = validateOutput(spec.output, response.output);
    const decision = decideRepair(verdict, attempts, REPAIR_POLICY);

    if (decision.ok && decision.action === "ACCEPT") {
      await sink({
        ...base,
        provider: route.provider,
        model: route.model,
        state: "SUCCEEDED",
        startedAt,
        finishedAt: now(),
        usage,
        errorCode: null,
        errorMessage: null,
      });
      // `verdict.ok` is true here by construction: ACCEPT is returned only for
      // a valid verdict. The cast is the type system's gap, not a shortcut.
      return { ok: true, output: (verdict as { ok: true; value: Record<string, unknown> }).value };
    }

    if (decision.ok && decision.action === "REPAIR") {
      attempts = decision.attempt;
      repairHint = verdict.ok ? null : `${verdict.reason}:${verdict.field ?? ""}`;
      continue;
    }

    // ---- AC-04. Budget exhausted: terminal and recorded. The invalid output
    // ---- is discarded here and reaches no consumer.
    await sink({
      ...base,
      provider: route.provider,
      model: route.model,
      state: "FAILED",
      startedAt,
      finishedAt: now(),
      usage,
      errorCode: "REPAIR_BUDGET_EXHAUSTED",
      errorMessage: verdict.ok ? null : `${verdict.reason} at ${verdict.field ?? "$"}`,
    });
    return { ok: false, errorCode: "REPAIR_BUDGET_EXHAUSTED", detail: null };
  }
}

/**
 * AC-02. The only way to invoke a tool on an agent's behalf.
 *
 * The tool NAME is chosen by the caller, and the permitted set comes from the
 * registry. Neither comes from model output — which is why an agent cannot
 * reach a tool by naming one, and why "the tool never executed" is provable
 * rather than asserted: `exec` is not reached on the refusal path at all.
 */
export async function callTool<T>(
  deps: { registry: Registry; onRefusal: (r: { agentName: string; tool: string; reason: string }) => Promise<void> },
  agentName: string,
  tool: string,
  exec: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const decision = checkTool(deps.registry, agentName, tool);
  if (!decision.ok) {
    await deps.onRefusal({ agentName, tool, reason: decision.reason });
    return { ok: false, reason: decision.reason };
  }
  return { ok: true, value: await exec() };
}
