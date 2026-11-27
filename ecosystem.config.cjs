// pm2 apps for a self-hosted server. Deploy with scripts/deploy.sh.
//   FORGESIGHT_APP_DIR  app directory (default: this file's directory)
//   BUN_PATH            bun binary (default: ~/.bun/bin/bun if present, else bun on PATH)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appDir = process.env.FORGESIGHT_APP_DIR || __dirname;
const logDir = path.join(appDir, "data", "logs");
const defaultBun = path.join(os.homedir(), ".bun", "bin", "bun");
const bun = process.env.BUN_PATH || (fs.existsSync(defaultBun) ? defaultBun : "bun");

const common = {
  cwd: appDir,
  interpreter: "none",
  autorestart: true,
  max_restarts: 10,
  min_uptime: "10s",
  exp_backoff_restart_delay: 100,
  log_date_format: "YYYY-MM-DD HH:mm:ss",
  merge_logs: true,
  env: { NODE_ENV: "production" },
};

module.exports = {
  apps: [
    {
      ...common,
      name: "forgesight-worker",
      script: bun,
      args: "run src/worker/main.ts",
      kill_timeout: 30000,
      out_file: path.join(logDir, "worker.out.log"),
      error_file: path.join(logDir, "worker.err.log"),
    },
    {
      ...common,
      name: "forgesight-web",
      script: bun,
      args: "scripts/start-web.ts",
      out_file: path.join(logDir, "web.out.log"),
      error_file: path.join(logDir, "web.err.log"),
    },
  ],
};
