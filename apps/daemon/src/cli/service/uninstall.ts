import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CliError, type CliIo } from "../open-home.ts";
import type { Command } from "../run-cli.ts";
import { UsageError } from "../usage.ts";
import { UNIT, unitFilePath, withHint } from "./common.ts";
import { removeLauncher } from "./launcher.ts";
import { createSystemd } from "./systemd.ts";
import { safePath } from "./unit.ts";

/** The home the installed unit uses: its `PAP_HOME` line, else the default. Read before the unit is deleted. */
function installedHome(unitPath: string): string {
  try {
    return /^Environment=PAP_HOME=(\S+)$/m.exec(readFileSync(unitPath, "utf8"))?.[1] ?? "~/.pap";
  } catch {
    return "~/.pap";
  }
}

function binDirOf(io: CliIo, given: string | undefined): string {
  try {
    return safePath("--bin-dir", given ?? join(io.homedir, ".local", "bin"));
  } catch {
    throw new CliError("--bin-dir must be an absolute path of letters, digits and . _ + @ / - only");
  }
}

export const serviceUninstall: Command = {
  options: { "bin-dir": { type: "string" } },
  async run({ values, positionals, io }) {
    if (positionals.length > 0) throw new UsageError("service uninstall takes no argument");
    const binDir = binDirOf(io, typeof values["bin-dir"] === "string" ? values["bin-dir"] : undefined);
    const systemd = createSystemd(io.env);
    const unitPath = unitFilePath(io);
    const home = installedHome(unitPath);
    const installed = existsSync(unitPath);
    const managerUp = await systemd.userManagerUp();
    if (!managerUp && installed)
      throw new CliError(
        "no systemd user manager, so the running service cannot be stopped; nothing was removed. Log in with a full session or set XDG_RUNTIME_DIR=/run/user/<uid>, then run this again",
      );
    // Only "not loaded" is tolerated; any other failure stops here, before the unit file is deleted.
    if (managerUp && (await systemd.loadState(UNIT)) !== "not-found") {
      await withHint(() => systemd.stop(UNIT));
      await withHint(() => systemd.disable(UNIT));
    }
    rmSync(unitPath, { force: true });
    removeLauncher(binDir);
    if (managerUp) await withHint(() => systemd.daemonReload());
    io.stdout.write(
      `${installed ? "pap service removed" : "no pap service was installed"}; your data stays in ${home} and is not deleted\n`,
    );
    return 0;
  },
};
