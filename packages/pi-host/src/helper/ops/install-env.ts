import { isAbsolute } from "node:path";
import { isDaemonOnlyEnvKey } from "@pap/contracts";

const SAFE_PATH = "/usr/bin:/bin";

/**
 * The environment of a child the helper starts to install something (`npx`, and the `npm` and `git` Pi starts): the
 * helper's own variables without what only the daemon holds (`PAP_*`, `NODE_OPTIONS`, the service manager's keys: the
 * one list of contracts); `PATH` reduced to its absolute entries (a relative one would run what a folder plants);
 * `HOME` the home folder; Pi's and the CLI's telemetry and update checks off.
 */
export function installEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !isDaemonOnlyEnvKey(key)) env[key] = value;
  const entries = (base.PATH ?? "").split(":").filter((entry) => isAbsolute(entry));
  return {
    ...env,
    PATH: entries.length > 0 ? entries.join(":") : SAFE_PATH,
    HOME: home,
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    npm_config_update_notifier: "false",
  };
}

/**
 * Pi starts `npm` and `git` from inside the helper and hands them the helper's `process.env` as it is at that moment.
 * This runs `run` with `process.env` replaced by `installEnv` (plus git never asking for a password on a terminal),
 * then puts every variable back. Only the helper's one operation runs meanwhile.
 */
export async function withInstallEnv<T>(home: string, run: () => Promise<T>): Promise<T> {
  const before = { ...process.env };
  const next = { ...installEnv(before, home), GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(process.env)) if (!(key in next)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, next);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in before)) Reflect.deleteProperty(process.env, key);
    Object.assign(process.env, before);
  }
}
