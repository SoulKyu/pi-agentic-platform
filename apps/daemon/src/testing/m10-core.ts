import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { M10Core } from "../compose-automation.ts";
import { M10_MIGRATION_SOURCES } from "../compose-m10.ts";
import { loadConfig } from "../kernel/config.ts";
import { createStreamHub } from "../kernel/ws/stream-hub.ts";
import { openOutboxBed, type OutboxBed } from "../kernel/testing/outbox-bed.ts";

export interface M10TestCore {
  readonly bed: OutboxBed;
  readonly core: M10Core;
  close(): void;
}

/** The shared inputs of the M10 composition over a real temporary database. */
export function openM10Core(readOnly = false): M10TestCore {
  const bed = openOutboxBed(M10_MIGRATION_SOURCES);
  const home = mkdtempSync(join(tmpdir(), "pap-m10-core-"));
  const config = loadConfig({
    argv: [],
    env: { PAP_HOME: join(home, ".pap"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
    cwd: home,
    homedir: home,
    totalMemMb: 16_384,
    piHostEntry: "/x/main.js",
    piHostExecArgv: [],
    staticRoot: null,
  });
  const env: NodeJS.ProcessEnv = {};
  return {
    bed,
    core: {
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      config,
      readOnly,
      hub: createStreamHub(undefined, bed.clock),
      env,
    },
    close() {
      bed.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
