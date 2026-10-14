import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ShellFacts } from "./policy/command-cover.ts";

/** The git variables that make git find or read its repository other than the config check assumes (owner m3). */
const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_INDEX_FILE"];

/** What the shell that runs a command adds to it, read at each evaluation: Pi's settings can change under a live worker (M7R15). */
export function shellFactsOf(
  settings: Pick<SettingsManager, "getShellCommandPrefix" | "getShellPath">,
  env: NodeJS.ProcessEnv,
): ShellFacts {
  return {
    commandPrefix: settings.getShellCommandPrefix(),
    shellPath: settings.getShellPath(),
    startupFile: env.BASH_ENV !== undefined || env.ENV !== undefined,
    cdPath: env.CDPATH !== undefined,
    gitEnv: GIT_ENV.some((name) => env[name] !== undefined),
    // An rg config file can carry `--pre`, which runs a program (MC16).
    rgConfig: env.RIPGREP_CONFIG_PATH !== undefined,
    path: env.PATH,
  };
}
