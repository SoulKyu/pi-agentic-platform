import { defaultDaemonProbes, type DaemonProbes } from "../doctor/checks-daemon.ts";

/** The probes of the daemon checks' tests: the migration list is fixed, nothing touches the machine. */
export const KNOWN_MIGRATIONS: ReadonlySet<string> = new Set(["001", "002", "003"]);

export const daemonProbes = (over: Partial<DaemonProbes> = {}): DaemonProbes => ({
  ...defaultDaemonProbes(),
  known: () => KNOWN_MIGRATIONS,
  ...over,
});
