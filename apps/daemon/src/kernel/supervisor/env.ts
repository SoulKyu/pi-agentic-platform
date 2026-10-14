import { isDaemonOnlyEnvKey } from "@pap/contracts";

// What the daemon's own environment must not hand to a worker, a helper or a PTY: its PAP_* settings and secrets,
// NODE_OPTIONS (a --require or --import there would run in every worker) and the platform's variables. Everything
// else passes: the child runs as the same user, so a denylist of what is known to matter is enough (R102).
/** What only the daemon holds: its settings, Node's options and the platform's secrets. Workers, helpers and PTYs share it, and so does the helper's own `npx`, `npm` and `git` (one list, in contracts). */
export const isDaemonOnly = isDaemonOnlyEnvKey;

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
