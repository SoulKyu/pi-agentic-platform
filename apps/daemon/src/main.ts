#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "./daemon.ts";
import { createSystemClock } from "./kernel/clock.ts";
import { ConfigError, loadConfig, type Config } from "./kernel/config.ts";
import { MigrationError } from "./kernel/db/migrate.ts";
import { HomeError, InstanceLockError } from "./kernel/home.ts";
import { createLogger } from "./kernel/logger.ts";
import { killAllWorkerGroups } from "./kernel/supervisor/worker.ts";
import { createShutdown, watchSignals, type Shutdown } from "./shutdown.ts";

const USAGE =
  "usage: pap serve [--dev] [--host <address>] [--port <port>] [--tls-cert <file> --tls-key <file>]\n";

function readConfig(argv: string[]): Config | null {
  const require = createRequire(import.meta.url);
  const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  try {
    return loadConfig({
      argv,
      env: process.env,
      cwd: process.cwd(),
      homedir: homedir(),
      totalMemMb: Math.floor(totalmem() / 1048576),
      piHostEntry: require.resolve("@pap/pi-host"),
      piHostExecArgv: process.execArgv.filter((arg) => arg.startsWith("--conditions")),
      staticRoot: existsSync(join(webDist, "index.html")) ? webDist : null,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (error instanceof ConfigError || code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`pap: ${(error as Error).message}\n${USAGE}`);
      return null;
    }
    throw error;
  }
}

// What an operator can fix and read in one line; anything else is a bug and keeps its stack trace.
const isStartupRefusal = (error: unknown): error is Error =>
  error instanceof InstanceLockError ||
  error instanceof HomeError ||
  error instanceof MigrationError ||
  ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"].includes((error as { code?: string } | null)?.code ?? "");

async function serve(config: Config): Promise<void> {
  const clock = createSystemClock();
  // A log reader that went away (a closed pipe) must not take the daemon down with it.
  process.stdout.on("error", () => {});
  const write = (line: string) => process.stdout.write(line);
  const logger = createLogger({ level: config.logLevel, clock, write });
  const operator = createLogger({ level: "info", clock, write });
  let shutdown: Shutdown | undefined;
  try {
    const daemon = await createDaemon(config, {
      clock,
      logger,
      announceSetupUrl: (fields) => operator.info("setup_url", fields),
      onFatal: () => (shutdown ? shutdown.trigger("server_error", 1) : process.exit(1)),
    });
    shutdown = createShutdown({
      stop: () => daemon.stop(),
      killWorkers: killAllWorkerGroups,
      exit: (code) => process.exit(code),
      clock,
      logger,
    });
    watchSignals(shutdown, process);
  } catch (error) {
    if (!isStartupRefusal(error)) throw error;
    process.stderr.write(`pap: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command !== "serve") {
  process.stderr.write(USAGE);
  process.exitCode = 64;
} else {
  const config = readConfig(rest);
  if (config) await serve(config);
  else process.exitCode = 64;
}
