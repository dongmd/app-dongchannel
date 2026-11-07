/**
 * PM2 definition of the SIMULATED Dong-Lumi worker (IMP-01 acceptance lane). It fabricates results ONLY for the assistants listed in
 * LUMI_SIM_SLUGS and rejects every other assistant (scripts/lumi-m1-worker.ts). It must be STOPPED before a real worker is started:
 * two workers on one database would race for the same runs.
 *
 * Secrets: the worker env file holds only what the worker needs (DATABASE_URL, LUMI_PLAN_MAX_TASKS, LUMI_SIM_SLUGS), mode 600, owned by the
 * runtime user. Nothing secret is in this file.
 *
 *   sudo -u opssite pm2 start deploy/pm2-lumi-sim.config.cjs && sudo -u opssite pm2 save
 *   sudo -u opssite pm2 stop lumi-worker-sim            # switch to real mode (see TDD 14.11.B.14)
 */
const APP_DIR = process.env.APP_DIR || "/home/opssite/htdocs/app.dongchannel.com/app";
const ENV_FILE = process.env.LUMI_WORKER_ENV_FILE || "/home/opssite/lumi-worker-sim.env";

module.exports = {
  apps: [
    {
      name: "lumi-worker-sim",
      cwd: APP_DIR,
      script: "/bin/bash",
      args: ["-c", `set -a; . ${ENV_FILE}; set +a; exec node --import tsx --conditions=react-server scripts/lumi-m1-worker.ts --simulate`],
      interpreter: "none",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
    },
  ],
};
