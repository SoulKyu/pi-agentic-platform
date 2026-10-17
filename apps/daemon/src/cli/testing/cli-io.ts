import { Readable } from "node:stream";
import { createFakeClock } from "../../kernel/clock.ts";
import type { CliIo } from "../open-home.ts";

/** A `CliIo` that keeps what the command writes; the clock is fake, stdin is empty unless given. */
export function cliIo(
  overrides: { env?: NodeJS.ProcessEnv; now?: number; homedir?: string; stdin?: CliIo["stdin"] } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdin: overrides.stdin ?? Object.assign(Readable.from([]), { isTTY: false }),
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    env: overrides.env ?? {},
    homedir: overrides.homedir ?? "/nonexistent-home",
    clock: createFakeClock(overrides.now),
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}
