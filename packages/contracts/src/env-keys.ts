/**
 * The service manager's variables of the daemon's own unit: C §2.5's "platform secrets" (M8R53, RT-27). One list for
 * every place that builds a child's environment (the supervisor's workers, helpers and PTYs, and the helper's own `npx`,
 * `npm` and `git` children), so they cannot drift apart.
 */
export const PLATFORM_ENV_KEYS: readonly string[] = Object.freeze([
  "NOTIFY_SOCKET",
  "LISTEN_FDS",
  "LISTEN_PID",
  "LISTEN_FDNAMES",
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "SYSTEMD_EXEC_PID",
  "MANAGERPID",
  "MANAGERPIDFDID",
  "MAINPID",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
  "CREDENTIALS_DIRECTORY",
  "MEMORY_PRESSURE_WATCH",
  "MEMORY_PRESSURE_WRITE",
]);

/** What only the daemon holds: its `PAP_*` settings, Node's options and the platform's secrets. */
export const isDaemonOnlyEnvKey = (key: string): boolean =>
  key.startsWith("PAP_") || key === "NODE_OPTIONS" || PLATFORM_ENV_KEYS.includes(key);
