// What the daemon's own environment must not hand to a worker: its PAP_* settings and secrets, and NODE_OPTIONS
// (a --require or --import there would run in every worker). Everything else passes: the worker runs as the same
// user, so a denylist of what is known to matter is enough (R102).
const isDaemonOnly = (key: string): boolean => key.startsWith("PAP_") || key === "NODE_OPTIONS";

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
