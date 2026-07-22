import "server-only";
import { spawn } from "node:child_process";

// AC02 — Hermes CLI exec helper. Chọn mode qua env:
//   HERMES_SSH_HOST=vocapro         → dev: ssh vocapro 'docker exec hermes hermes ...'
//   (unset, prod trên VPS)           → local: docker exec hermes hermes ...
// Không dùng shell interpolation — spawn với args array để tránh injection.

export interface ExecOptions {
  timeoutMs?: number;
  stdinData?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function resolveCommand(hermesArgs: string[]): { cmd: string; args: string[] } {
  const sshHost = process.env.HERMES_SSH_HOST;
  const container = process.env.HERMES_CONTAINER_NAME ?? "hermes";
  const dockerArgs = ["exec", container, "hermes", ...hermesArgs];
  if (sshHost) {
    // ssh spawn: các arg sau host được join thành 1 chuỗi bởi ssh — cần quote.
    // Dùng shell-safe quoting đơn giản (giá trị đến từ code, không phải user input).
    const remote = ["docker", ...dockerArgs].map(shellQuote).join(" ");
    return { cmd: "ssh", args: [sshHost, remote] };
  }
  return { cmd: "docker", args: dockerArgs };
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function execHermes(hermesArgs: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const { cmd, args } = resolveCommand(hermesArgs);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return await new Promise<ExecResult>((resolve, reject) => {
    const start = performance.now();
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    const stdoutChunks: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`execHermes timeout sau ${timeout}ms: ${cmd} ${args.join(" ")}`));
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      stdout = stdoutChunks.join("");
      const durationMs = Math.round(performance.now() - start);
      resolve({ stdout, stderr, exitCode: code ?? -1, durationMs });
    });

    if (opts.stdinData) child.stdin.write(opts.stdinData);
    child.stdin.end();
  });
}

// Helper: export sessions JSONL từ 1 profile.
// Trả từng session parsed (1 JSONL line = 1 session với nested messages).
export async function exportSessionsJsonl(profile: string, extraArgs: string[] = []): Promise<unknown[]> {
  const result = await execHermes(
    ["-p", profile, "sessions", "export", "--format", "jsonl", "-", ...extraArgs],
    { timeoutMs: 90_000 },
  );
  if (result.exitCode !== 0) {
    // Không session vẫn có thể exit 0 với stdout rỗng — không throw ở empty case.
    throw new Error(
      `hermes sessions export -p ${profile} exit=${result.exitCode}: ${result.stderr.slice(0, 500)}`,
    );
  }
  const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
  const parsed: unknown[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (err) {
      console.warn(`[hermes-exec] skip malformed JSONL line (len=${line.length}):`, (err as Error).message);
    }
  }
  return parsed;
}
