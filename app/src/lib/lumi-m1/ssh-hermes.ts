/* eslint-disable @typescript-eslint/no-explicit-any -- error objects from child_process */
/**
 * App → Hermes direction, the REAL adapter (test profile only). Direction is separate from "Hermes calls the app" (MCP): here the
 * app's worker starts ONE agent run on the VPS over SSH:
 *
 *   ssh <host> docker exec -d hermes sh -c 'hermes -p <profile> chat -Q -q "<prompt>" --max-turns N --source tool'
 *
 * - The prompt carries only the run id and the instruction to call the MCP tools; the task text is fetched by the agent through
 *   `knowledge_context` (least privilege, smaller injection surface).
 * - Hermes has NO idempotency key. Duplicate-execution defence is therefore on the app side: (1) the outbox row is never resent
 *   after the run is DISPATCHED/UNCERTAIN (core.ts), (2) before launching we look for a live process carrying the run marker, and
 *   (3) the MCP submit is exactly-once per run. This does NOT prove Hermes never runs twice; it bounds the damage to one extra model run.
 * - stop(): kill by marker and VERIFY no process remains. Only then is the run "stop confirmed" (remote_stop_state).
 * Secrets: nothing secret is passed on the command line (the model key and MCP token live in the profile's .env on the VPS).
 */
import { execFile } from "node:child_process";
import type { HermesPort, HermesStopPort, StopResult } from "./core";
import { parseHermesToolsList } from "./hermes-tools";

export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface SshHermesOptions { exec?: ExecFn; host: string; container?: string; profile: string; maxTurns: number; runDeadlineSeconds: number; connectTimeoutSeconds?: number }

const defaultExec: ExecFn = (file: string, args: string[], timeoutMs: number) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (e, stdout, stderr) => {
      const code = e ? (typeof (e as any).code === "number" ? (e as any).code : e.killed ? 124 : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export const runMarker = (runId: string) => `LUMI-RUN-${runId}`;
const grepPat = (runId: string) => `[L]UMI-RUN-${runId}`; // bracket trick: the checking shell's own command line does not match itself
const NOT_REACHED = /(Could not resolve|Connection timed out|Connection refused|No route to host|Network is unreachable|Permission denied|Operation timed out)/i;

export class SshHermes implements HermesPort, HermesStopPort {
  constructor(private o: SshHermesOptions) {}
  private ssh(remote: string, timeoutMs = 30_000) {
    return (this.o.exec ?? defaultExec)("ssh", ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${this.o.connectTimeoutSeconds ?? 10}`, this.o.host, remote], timeoutMs);
  }
  private dx(cmd: string) { return `docker exec ${this.o.container ?? "hermes"} sh -c '${cmd.replace(/'/g, `'\\''`)}'`; }

  async readProfileTools(profile: string): Promise<string[] | null> {
    const r = await this.ssh(`docker exec ${this.o.container ?? "hermes"} hermes -p ${profile.replace(/[^a-z0-9_-]/gi, "")} tools list`, 60_000);
    if (r.code !== 0) return null;
    const parsed = parseHermesToolsList(r.stdout);
    if (parsed.length === 0) return null;
    // Hermes MCP tools appear as `server:tool`; the app names them `tool.name` (underscore -> dot) — see TDD 8.8.
    return [...new Set(parsed.flatMap((p) => p.enabled).map((n) => (n.includes(":") ? n.split(":").slice(1).join(":").replace(/_/g, ".") : n)))];
  }

  async dispatch(r: { runId: string; dispatchKey: string; taskCode: string; instruction: Record<string, unknown> }) {
    const marker = runMarker(r.runId);
    const already = await this.ssh(this.dx(`pgrep -f '${grepPat(r.runId)}' >/dev/null && echo RUNNING || echo NONE`));
    if (already.code === 0 && already.stdout.includes("RUNNING")) return { kind: "accepted" as const, sessionRef: `ssh:${marker}` }; // never start a second copy
    const prompt =
      `${marker}\nBạn là trợ lý Lumi Test. Đây là lượt chạy run_id=${r.runId} của việc ${r.taskCode}.\n` +
      `1) Gọi công cụ knowledge_context với run_id trên để đọc việc được giao.\n2) Làm đúng yêu cầu bằng tiếng Việt, ngắn gọn.\n` +
      `3) Gọi outputs_submit đúng MỘT lần với run_id và nội dung. Không làm gì khác, không dùng công cụ khác.`;
    const b64 = Buffer.from(prompt, "utf8").toString("base64");
    const log = `/tmp/lumi-run-${r.runId}.log`;
    const inner = `P=$(echo ${b64} | base64 -d); exec timeout ${Math.max(30, this.o.runDeadlineSeconds)} hermes -p ${this.o.profile} chat -Q -q "$P" --max-turns ${this.o.maxTurns} --source tool > ${log} 2>&1`;
    const launch = await this.ssh(`docker exec -d ${this.o.container ?? "hermes"} sh -c '${inner}'`);
    if (launch.code !== 0 && NOT_REACHED.test(launch.stderr)) return { kind: "rejected" as const, transient: true, message: "SSH không tới được VPS (chưa gửi lệnh)" };
    // Whatever the exit code, ask the remote what happened: a live process or a log file proves the command reached Hermes.
    await new Promise((res) => setTimeout(res, 1500));
    const check = await this.ssh(this.dx(`(pgrep -f '${grepPat(r.runId)}' >/dev/null && echo RUNNING) || ([ -f ${log} ] && echo STARTED) || echo NONE`));
    if (check.code === 0 && /RUNNING|STARTED/.test(check.stdout)) return { kind: "accepted" as const, sessionRef: `ssh:${marker}` };
    if (check.code === 0 && launch.code === 0) return { kind: "uncertain" as const, message: "Đã chạy lệnh nhưng không thấy tiến trình hay log trên Hermes" };
    return { kind: "uncertain" as const, message: `Không xác minh được (mã ${launch.code}/${check.code}); không tự gửi lại` };
  }

  async stop(r: { runId: string; dispatchKey: string }): Promise<StopResult> {
    const k = await this.ssh(this.dx(`pkill -f '${grepPat(r.runId)}'; sleep 1; pgrep -f '${grepPat(r.runId)}' >/dev/null && echo ALIVE || echo GONE`));
    if (k.code !== 0) return { confirmed: false, message: `Không kết nối được để dừng (mã ${k.code})` };
    return k.stdout.includes("GONE") ? { confirmed: true } : { confirmed: false, message: "Tiến trình vẫn còn sau khi kill" };
  }
}
