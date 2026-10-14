// What the daemon's own environment must not hand to a worker, a helper or a PTY: its PAP_* settings and secrets,
// NODE_OPTIONS (a --require or --import there would run in every worker) and the platform's variables. Everything
// else passes: the child runs as the same user, so a denylist of what is known to matter is enough (R102).
/** The service manager's variables of the daemon's own unit: C §2.5's "platform secrets" (M8R53, RT-27). */
const PLATFORM_KEYS: ReadonlySet<string> = new Set([
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

/** What only the daemon holds: its settings, Node's options and the platform's secrets. Workers, helpers and PTYs share it. */
export const isDaemonOnly = (key: string): boolean =>
  key.startsWith("PAP_") || key === "NODE_OPTIONS" || PLATFORM_KEYS.has(key);

export function workerEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !isDaemonOnly(key)) env[key] = value;
  // Telemetry and the version check stay off whatever the caller passes.
  return { ...env, ...extra, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
}
