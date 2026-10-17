import { isAbsolute, join } from "node:path";
import { ConfigError } from "./config.ts";

/**
 * `PI_CODING_AGENT_DIR`, or `~/.pi/agent`: the folder pap shares with Pi. Same rule as `homeFrom`: empty means unset, a
 * leading `~` expands, a relative path is refused. Kept here because `kernel/config.ts` is not edited by M6b.
 */
export function piAgentDirFrom(env: NodeJS.ProcessEnv, homedir: string): string {
  const raw = env.PI_CODING_AGENT_DIR;
  if (raw === undefined || raw === "") return join(homedir, ".pi", "agent");
  const expanded = raw === "~" ? homedir : raw.startsWith("~/") ? join(homedir, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) throw new ConfigError("PI_CODING_AGENT_DIR must be an absolute path");
  return expanded;
}
