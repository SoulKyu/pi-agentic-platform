import { readFileSync, readdirSync, rmSync, rmdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_NET } from "@pap/contracts";
import { CliError } from "../open-home.ts";
import type { Command } from "../run-cli.ts";
import { UsageError } from "../usage.ts";
import { KATA_MARKER, NERDCTL_NAMESPACE } from "./configs.ts";
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

/** The file the CNI library writes per attachment: `<network>-<container id>-<ifname>`; the container id is 64 hex. */
const OWN_RESULT = new RegExp(`^${AGENT_NET.network}-[0-9a-f]{64}-[A-Za-z0-9]+$`);

/** A mount point of /proc/self/mountinfo (field 5) that is `dir` or below it. */
function mountedUnder(mountinfo: string, dirs: readonly string[]): string | undefined {
  for (const line of mountinfo.split("\n")) {
    const point = line.split(" ")[4];
    if (point !== undefined && dirs.some((dir) => point === dir || point.startsWith(`${dir}/`))) return point;
  }
  return undefined;
}

/** /var/lib/cni is shared with other CNI users: only the results and reservations of pap's own network go. */
function removeCniState(dir: string): void {
  try {
    for (const name of readdirSync(join(dir, "results")))
      if (OWN_RESULT.test(name)) rmSync(join(dir, "results", name), { force: true });
  } catch {
    // no results folder
  }
  rmSync(join(dir, "networks", AGENT_NET.network), { recursive: true, force: true });
  for (const sub of ["results", "networks"]) removeIfEmpty(join(dir, sub));
  removeIfEmpty(dir);
}

const ownedBySetup = (dir: string): boolean => existsSync(join(dir, SETUP_MARKER));

/** Removes exactly what `runSetup` wrote. A stop or delete that fails because the thing is already gone is not an error. */
export async function runUninstall(
  options: { purge: boolean },
  deps: VmDeps,
  io: { stdout: { write(t: string): unknown } },
): Promise<number> {
  if (!deps.isRoot) throw new CliError("pap vm uninstall must run as root: run with sudo");
  const { roots } = deps;
  // containerd's unit has KillMode=process: its shims and their VMs outlive its stop. While it runs, every container of pap's
  // namespace is removed (a VM that cannot be removed stops the uninstall below, at the mount check).
  const nerdctl = [
    "--address",
    `${roots.run}/containerd.sock`,
    "--namespace",
    NERDCTL_NAMESPACE,
    "--data-root",
    `${roots.state}/nerdctl`,
    "--cni-path",
    `${roots.opt}/libexec/cni`,
    "--cni-netconfpath",
    `${roots.etc}/cni`,
  ];
  const listed = await deps.exec(`${roots.opt}/bin/nerdctl`, [...nerdctl, "ps", "-a", "-q"]);
  const containers = listed.stdout.split("\n").filter((id) => /^[0-9a-f]{12,64}$/.test(id.trim()));
  if (containers.length > 0)
    await deps.exec(`${roots.opt}/bin/nerdctl`, [
      ...nerdctl,
      "rm",
      "--force",
      ...containers.map((id) => id.trim()),
    ]);
  await deps.exec("systemctl", ["disable", "--now", ...[...UNIT_NAMES].reverse()]);
  const left = mountedUnder(deps.readMounts(), [roots.run, roots.state]);
  if (left !== undefined)
    throw new CliError(
      `${left} is still mounted: a VM or container of pap is still running; nothing was removed. Stop it, then run pap vm uninstall again`,
    );
  for (const name of UNIT_NAMES) rmSync(join(roots.units, name), { force: true });
  await deps.exec("systemctl", ["daemon-reload"]);
  // A unit that failed while it was stopped stays in `systemctl --failed` after its file is gone.
  await deps.exec("systemctl", ["reset-failed", ...UNIT_NAMES]);
  await deps.exec("ip", ["link", "delete", AGENT_NET.bridge]);
  await deps.exec("nft", ["delete", "table", "inet", "pap_agents"]);
  await deps.exec("nft", ["delete", "table", "bridge", "pap_agents"]);

  for (const file of ETC_FILES) rmSync(join(roots.etc, file), { force: true });
  rmSync(join(roots.etc, "cni", `${AGENT_NET.network}.conflist`), { force: true });
  // T20a: nerdctl keeps its lock and a default network in the config folder, so /etc/pap-vm holds more than setup wrote: it is pap's.
  rmSync(roots.etc, { recursive: true, force: true });
  // The units are stopped: containerd's runtime state, the IPAM reservations and the docker config in /run/pap-vm are not in use.
  rmSync(roots.run, { recursive: true, force: true });
  removeCniState(roots.cniState);

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
