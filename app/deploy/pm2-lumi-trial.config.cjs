/**
 * PM2 definition of the REAL-trial lane (IMP-01, aff-trial) — run by the `dlumi` user on the VPS (docker group), from /home/dlumi/lumi-trial/src/app.
 * env files (mode 600, not in git): mcp.env = DATABASE_URL, LUMI_BOT_TOKENS=aff-trial:<random>, LUMI_MCP_PORT, LUMI_PLAN_MAX_TASKS
 *                                  worker.env = DATABASE_URL, LUMI_PLAN_MAX_TASKS, LUMI_RUN_TOTAL_CAPS, LUMI_REAL_SLUGS=aff-trial, LUMI_HERMES_SSH_HOST=local,
 *                                               LUMI_HERMES_PROFILE=aff-trial, LUMI_HERMES_MAX_TURNS, LUMI_RUN_DEADLINE_SECONDS, LUMI_HERMES_MODE=ssh
 * The simulated worker (deploy/pm2-lumi-sim.config.cjs) must be STOPPED while this worker is on (one lane at a time).
 */
const SRC = "/home/dlumi/lumi-trial/src/app";
const run = (envFile, script, extra = "") => ["-c", `set -a; . /home/dlumi/lumi-trial/${envFile}; set +a; exec node --import tsx --conditions=react-server ${script} ${extra}`];
module.exports = {
  apps: [
    { name: "lumi-mcp-trial", cwd: SRC, script: "/bin/bash", interpreter: "none", args: run("mcp.env", "scripts/lumi-m1-mcp-server.ts", "--port 38299"), autorestart: true, max_restarts: 10, restart_delay: 5000, time: true },
    { name: "lumi-worker-trial", cwd: SRC, script: "/bin/bash", interpreter: "none", args: run("worker.env", "scripts/lumi-m1-worker.ts", "--hermes-ssh"), autorestart: true, max_restarts: 10, restart_delay: 5000, time: true },
  ],
};
