import { defaultDaemonProbes, type DaemonProbes } from "../doctor/checks-daemon.ts";

/** The probes of the daemon checks' tests: the migration list is fixed, the sandbox and the trust test never touch the machine. */
export const KNOWN_MIGRATIONS: ReadonlySet<string> = new Set(["001", "002", "003"]);

export const daemonProbes = (over: Partial<DaemonProbes> = {}): DaemonProbes => ({
  ...defaultDaemonProbes(),
  known: () => KNOWN_MIGRATIONS,
  sandbox: async () => ({ usable: true, path: "/usr/bin/bwrap" }),
  trusted: (path) => path,
  ...over,
});
