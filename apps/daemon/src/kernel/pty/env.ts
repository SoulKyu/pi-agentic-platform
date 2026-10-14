import { isDaemonOnly } from "../supervisor/env.ts";

/** The workers' rule: pap's settings and the platform's secrets never reach a shell (M8R53). */
export function shellEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !isDaemonOnly(key)) env[key] = value;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (env.LANG === undefined && env.LC_ALL === undefined && env.LC_CTYPE === undefined) env.LANG = "C.UTF-8";
  return env;
}
