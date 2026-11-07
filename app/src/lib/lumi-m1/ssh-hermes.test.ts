import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SshHermes, runMarker, type ExecFn } from "./ssh-hermes";

const RUN = "11111111-2222-4333-8444-555555555555";
const mk = (script: (remote: string, n: number) => { code: number; stdout?: string; stderr?: string }) => {
  const calls: string[] = [];
  const exec: ExecFn = async (_f, args) => { const remote = args[args.length - 1]!; calls.push(remote); const r = script(remote, calls.length); return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; };
  return { calls, h: new SshHermes({ exec, host: "h", profile: "lumitest", maxTurns: 8, runDeadlineSeconds: 600 }) };
};
const run = { runId: RUN, dispatchKey: `run:${RUN}`, taskCode: "DL-001", instruction: {} };
const launched = (c: string[]) => c.filter((x) => x.includes("chat -Q -q")).length;


describe("SshHermes host=local (worker on the Hermes machine)", () => {
  it("runs the command through a local shell, never ssh", async () => {
    const files: string[] = [];
    const exec: ExecFn = async (f, args) => { files.push(f); return { code: 0, stdout: args[args.length - 1]!.includes("pgrep") ? "RUNNING" : "", stderr: "" }; };
    const h = new SshHermes({ exec, host: "local", profile: "lumitest", maxTurns: 8, runDeadlineSeconds: 600 });
    assert.equal((await h.dispatch(run)).kind, "accepted");
    assert.ok(files.length > 0 && files.every((f) => f === "sh"));
  });
});

describe("SshHermes prompt by run purpose (IMP-01)", () => {
  const promptOf = async (instruction: Record<string, unknown>) => {
    const { h, calls } = mk((_r, n) => (n === 1 ? { code: 0, stdout: "NONE" } : { code: 0, stdout: "STARTED" }));
    await h.dispatch({ ...run, instruction });
    const cmd = calls.find((c) => c.includes("chat -Q -q"))!;
    return Buffer.from(/echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(cmd)![1]!, "base64").toString("utf8");
  };
  it("a PLAN run is told to call plan_submit_version and NOT outputs_submit; a TASK run keeps the output prompt", async () => {
    const plan = await promptOf({ run_purpose: "PLAN" });
    assert.ok(plan.includes("plan_submit_version") && plan.includes("Không gọi outputs_submit"));
    assert.equal(plan.includes("Gọi outputs_submit đúng MỘT lần"), false);
    const task = await promptOf({ run_purpose: "TASK" });
    assert.ok(task.includes("Gọi outputs_submit đúng MỘT lần") && !task.includes("plan_submit_version"));
    assert.ok(task.includes("Gọi outputs_submit") && (await promptOf({})).includes("Gọi outputs_submit đúng MỘT lần"));
  });
});

describe("SshHermes dispatch classification (app -> Hermes direction)", () => {
  it("a live process with the run marker => accepted and NO second launch (duplicate-execution guard)", async () => {
    const { h, calls } = mk(() => ({ code: 0, stdout: "RUNNING" }));
    assert.equal((await h.dispatch(run)).kind, "accepted");
    assert.equal(launched(calls), 0);
  });
  it("launched and a log/process is visible => accepted, exactly one launch", async () => {
    const { h, calls } = mk((r, n) => (n === 1 ? { code: 0, stdout: "NONE" } : r.includes("chat -Q -q") ? { code: 0 } : { code: 0, stdout: "STARTED" }));
    assert.equal((await h.dispatch(run)).kind, "accepted");
    assert.equal(launched(calls), 1);
  });
  it("SSH could not reach the VPS => rejected TRANSIENT (safe: nothing was sent)", async () => {
    const { h } = mk(() => ({ code: 255, stderr: "ssh: connect to host x port 22: Connection timed out" }));
    const r = await h.dispatch(run);
    assert.deepEqual([r.kind, "transient" in r ? r.transient : null], ["rejected", true]);
  });
  it("launch returned OK but nothing is visible afterwards => UNCERTAIN (never resent blindly)", async () => {
    const { h } = mk((r, n) => (n === 1 ? { code: 0, stdout: "NONE" } : r.includes("chat -Q -q") ? { code: 0 } : { code: 0, stdout: "NONE" }));
    assert.equal((await h.dispatch(run)).kind, "uncertain");
  });
  it("connection dropped mid-launch and the follow-up check also fails => UNCERTAIN, not a retry", async () => {
    const { h } = mk((r, n) => (n === 1 ? { code: 0, stdout: "NONE" } : r.includes("chat -Q -q") ? { code: 255, stderr: "Connection reset by peer" } : { code: 255, stderr: "Connection reset by peer" }));
    assert.equal((await h.dispatch(run)).kind, "uncertain");
  });
  it("the prompt carries the run marker and run id but NOT the task text, and no secret is on the command line", async () => {
    const { h, calls } = mk((r, n) => (n === 1 ? { code: 0, stdout: "NONE" } : { code: 0, stdout: "STARTED" }));
    await h.dispatch({ ...run, instruction: { text: "NỘI DUNG VIỆC BÍ MẬT" } });
    const cmd = calls.find((c) => c.includes("chat -Q -q"))!;
    const b64 = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(cmd)![1]!;
    const prompt = Buffer.from(b64, "base64").toString("utf8");
    assert.ok(prompt.includes(runMarker(RUN)) && prompt.includes(RUN));
    assert.equal(prompt.includes("BÍ MẬT"), false);
    assert.ok(cmd.includes("--max-turns 8") && cmd.includes("timeout 600"));
    assert.equal(/sk-|Bearer|TOKEN/i.test(cmd), false);
  });
});

describe("SshHermes stop (only a VERIFIED kill counts)", () => {
  it("process gone after kill => confirmed", async () => {
    const { h } = mk(() => ({ code: 0, stdout: "GONE" }));
    assert.deepEqual(await h.stop({ runId: RUN, dispatchKey: "k" }), { confirmed: true });
  });
  it("process still alive => NOT confirmed", async () => {
    const { h } = mk(() => ({ code: 0, stdout: "ALIVE" }));
    assert.equal((await h.stop({ runId: RUN, dispatchKey: "k" })).confirmed, false);
  });
  it("cannot reach the VPS => NOT confirmed (the app stopped waiting, Hermes may still run)", async () => {
    const { h } = mk(() => ({ code: 255, stderr: "Connection refused" }));
    assert.equal((await h.stop({ runId: RUN, dispatchKey: "k" })).confirmed, false);
  });
});

describe("readProfileTools maps MCP server:tool to the app's tool names", () => {
  it("lumiapp:tasks_intake -> tasks.intake; an unrestricted server stays unmapped (refused by the allowlist)", async () => {
    const nl = String.fromCharCode(10);
    const out = ["Built-in toolsets (cli):", "  ✗ disabled  web  x", "", "MCP servers:", "  lumiapp  [include only: tasks_intake, outputs_submit]", ""].join(nl);
    const { h } = mk(() => ({ code: 0, stdout: out }));
    assert.deepEqual(await h.readProfileTools("lumitest"), ["tasks.intake", "outputs.submit"]);
    const open = mk(() => ({ code: 0, stdout: ["MCP servers:", "  lumiapp  all tools enabled", ""].join(nl) }));
    assert.deepEqual(await open.h.readProfileTools("lumitest"), ["*"]);
  });
});
