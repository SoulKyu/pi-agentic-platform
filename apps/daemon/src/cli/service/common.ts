import { isAbsolute, join } from "node:path";
import { CliError, type CliIo } from "../open-home.ts";

export const UNIT = "pap.service";
export const JOURNAL_HINT = "journalctl --user -u pap -n 30";

export function unitFilePath(io: CliIo, unit: string = UNIT): string {
  const configured = io.env.XDG_CONFIG_HOME;
  const config =
    configured !== undefined && isAbsolute(configured) ? configured : join(io.homedir, ".config");
  return join(config, "systemd", "user", unit);
}

/** A failed systemctl call is a fixed sentence plus the exit code (from the wrapper) and the journal hint. */
export async function withHint<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof CliError && !error.message.includes(JOURNAL_HINT))
      throw new CliError(`${error.message}; see: ${JOURNAL_HINT}`, error.exitCode);
    throw error;
  }
}

/** `pap service install` exit code: installed, but the user journal is unreadable, so the start could not be checked (W5-R18). */
export const UNVERIFIED_EXIT = 3;

/** The kernel Clock unrefs its timers (the daemon must exit on signal), so a CLI that sleeps on it needs the loop held open. */
export async function waitWithLoopHeld<T>(wait: () => Promise<T>): Promise<T> {
  const hold = setInterval(() => undefined, 60_000);
  try {
    return await wait();
  } finally {
    clearInterval(hold);
  }
}
