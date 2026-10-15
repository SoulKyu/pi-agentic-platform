import { NETWORK_ENV, TOOLING_ENV, unattendedEnv } from "@pap/contracts";

/**
 * The environment of a child the helper starts to install something (`npx`, and the `npm` and `git` Pi starts): the
 * shared unattended allowlist (owner c7, decision 81) with the network and tooling names, `HOME` the home folder, `PI_CODING_AGENT_DIR` the agent folder (not a secret; pap lists skills from it), and
 * Pi's and the CLI's telemetry and update checks off. No SSH agent, provider key or registry token reaches an install.
 */
export function installEnv(base: NodeJS.ProcessEnv, home: string, agentDir?: string): NodeJS.ProcessEnv {
  return {
    ...unattendedEnv(base, {
      keep: [...NETWORK_ENV, ...TOOLING_ENV],
      set: {
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        npm_config_update_notifier: "false",
        ...(agentDir === undefined ? {} : { PI_CODING_AGENT_DIR: agentDir }),
      },
    }),
    HOME: home,
  };
}

/**
 * Pi starts `npm` and `git` from inside the helper and hands them the helper's `process.env` as it is at that moment.
 * This runs `run` with `process.env` replaced by `installEnv` (plus git never asking for a password on a terminal),
 * then puts every variable back. Only the helper's one operation runs meanwhile.
 */
export async function withInstallEnv<T>(home: string, run: () => Promise<T>, agentDir?: string): Promise<T> {
  const before = { ...process.env };
  const next = { ...installEnv(before, home, agentDir), GIT_TERMINAL_PROMPT: "0" };
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
