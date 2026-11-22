// Runs the bot and restarts it if it crashes, with exponential backoff.
// Usage: node supervisor.js   (or: npm run exec)
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const BOT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist", "soundboard-bot.js");

// Must match EXIT_CONFIG_ERROR in soundboard-bot.ts: a config problem a restart can't fix.
const EXIT_CONFIG_ERROR = 78;

const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
// If the bot stayed up this long, treat the next crash as fresh and reset the backoff.
const STABLE_RUN_MS = 60_000;

let delay = MIN_DELAY_MS;
let child = null;
let stopping = false;
let restartTimer = null;

function start() {
  const startedAt = Date.now();

  child = spawn(process.execPath, [BOT_SCRIPT], { stdio: "inherit" });

  child.on("error", error => {
    console.error("[supervisor] Failed to start bot:", error);
  });

  child.on("exit", (code, signal) => {
    child = null;

    if (stopping) {
      process.exit(code ?? 0);
    }

    if (code === 0) {
      console.log("[supervisor] Bot exited cleanly; not restarting.");
      process.exit(0);
    }

    if (code === EXIT_CONFIG_ERROR) {
      console.error("[supervisor] Bot exited due to a configuration error; fix it and start again. Not restarting.");
      process.exit(code);
    }

    if (Date.now() - startedAt >= STABLE_RUN_MS) {
      delay = MIN_DELAY_MS;
    }

    console.error(`[supervisor] Bot exited (${signal ?? `code ${code}`}); restarting in ${delay / 1000}s...`);

    restartTimer = setTimeout(start, delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  });
}

function stop(signal) {
  stopping = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  if (child) {
    child.kill(signal);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

start();
