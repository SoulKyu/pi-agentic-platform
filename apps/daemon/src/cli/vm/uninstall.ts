import { readFileSync, readdirSync, rmSync, rmdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_NET } from "@pap/contracts";
import { CliError } from "../open-home.ts";
import type { Command } from "../run-cli.ts";
import { UsageError } from "../usage.ts";
import { KATA_MARKER } from "./configs.ts";
import type { VmDeps } from "./deps.ts";
import { realDeps } from "./real-deps.ts";
import { SETUP_MARKER } from "./setup.ts";
import { UNIT_NAMES } from "./units.ts";

const ETC_FILES = ["config.json", "containerd.toml", "buildkitd.toml", "agents.nft"] as const;

const removeIfEmpty = (dir: string): void => {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // absent or not empty: another owner's files stay
  }
};

const ownedBySetup = (dir: string): boolean => existsSync(join(dir, SETUP_MARKER));

/** Removes exactly what `runSetup` wrote. A stop or delete that fails because the thing is already gone is not an error. */
export async function runUninstall(
  options: { purge: boolean },
  deps: VmDeps,
  io: { stdout: { write(t: string): unknown } },
): Promise<number> {
  if (!deps.isRoot) throw new CliError("pap vm uninstall must run as root: run with sudo");
  const { roots } = deps;
  await deps.exec("systemctl", ["disable", "--now", ...[...UNIT_NAMES].reverse()]);
  for (const name of UNIT_NAMES) rmSync(join(roots.units, name), { force: true });
  await deps.exec("systemctl", ["daemon-reload"]);
  await deps.exec("ip", ["link", "delete", AGENT_NET.bridge]);
  await deps.exec("nft", ["delete", "table", "inet", "pap_agents"]);
  await deps.exec("nft", ["delete", "table", "bridge", "pap_agents"]);

  for (const file of ETC_FILES) rmSync(join(roots.etc, file), { force: true });
  rmSync(join(roots.etc, "cni", `${AGENT_NET.network}.conflist`), { force: true });
  removeIfEmpty(join(roots.etc, "cni"));
  removeIfEmpty(roots.etc);

  let kataKept = false;
  try {
    if (readFileSync(roots.kataConfig, "utf8").startsWith(`${KATA_MARKER}\n`)) rmSync(roots.kataConfig);
    else kataKept = true;
  } catch {
    // no file: nothing to remove
  }
  if (kataKept) io.stdout.write(`${roots.kataConfig} is not pap's and stays\n`);
  removeIfEmpty(dirname(roots.kataConfig));
  removeIfEmpty(dirname(dirname(roots.kataConfig)));

  for (const dir of [roots.opt, roots.kata])
    if (ownedBySetup(dir)) rmSync(dir, { recursive: true, force: true });
  if (options.purge) rmSync(roots.state, { recursive: true, force: true });
  io.stdout.write(
    options.purge
      ? "pap vm removed, and its data\n"
      : `pap vm removed; ${roots.state} is kept (use --purge to delete it)\n`,
  );
  return 0;
}

export const vmUninstall: Command = {
  options: { purge: { type: "boolean" } },
  run({ values, positionals, io }) {
    if (positionals.length > 0) throw new UsageError("vm uninstall takes no argument");
    return runUninstall({ purge: values.purge === true }, realDeps(), io);
  },
};
