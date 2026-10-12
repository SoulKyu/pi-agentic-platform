import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../../main.ts", import.meta.url));

/** The real entry point in a child process; `input` is its standard input (a pipe, never a terminal). */
export const pap = (args: string[], env: NodeJS.ProcessEnv, input?: string) =>
  spawnSync(
    process.execPath,
    ["--conditions=development", "--disable-warning=ExperimentalWarning", MAIN, ...args],
    { env, encoding: "utf8", timeout: 30_000, ...(input === undefined ? {} : { input }) },
  );
