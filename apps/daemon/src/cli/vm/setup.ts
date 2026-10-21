import { agentNetRuleset, AGENT_NET } from "@pap/contracts";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Command } from "../run-cli.ts";
import { CliError, type CliIo } from "../open-home.ts";
import { parseUnit } from "../service/unit-read.ts";
import { UsageError } from "../usage.ts";
import {
  applyOverrides,
  fetchVerified,
  isPlaceholder,
  type AssetName,
  type VmAsset,
  type VmAssets,
} from "./assets.ts";
import {
  KATA_MARKER,
  PATHS,
  buildkitdToml,
  conflist,
  containerdToml,
  kataConfig,
  shimWrapper,
  vmdConfig,
} from "./configs.ts";
import type { VmDeps } from "./deps.ts";
import { realDeps } from "./real-deps.ts";
import { assertRootOwnedCode } from "./trusted-code.ts";
import { UNIT_FILES, UNIT_NAMES } from "./units.ts";

export const SETUP_MARKER = ".pap-vm-setup";
export const DEV_RESIDUAL = "Code your user can change will run as root (testing only).";
const MAX_ID = 2 ** 31;

export interface SetupOptions {
  readonly user: string | undefined;
  readonly home: string | undefined;
  readonly assets: string | undefined;
  readonly devFromTree: boolean;
}

type Marker = { installed: Record<string, string> };

const readMarker = (dir: string): Marker | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SETUP_MARKER), "utf8")) as Marker;
    return typeof parsed.installed === "object" && parsed.installed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** A folder pap did not make is never taken over (R5): it exists and has no pap marker. */
const refuseForeign = (dir: string): void => {
  if (existsSync(dir) && readMarker(dir) === undefined)
    throw new CliError(`${dir} exists and was not made by pap vm setup: refusing to use it`);
};

const checkId = (what: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value >= MAX_ID)
    throw new CliError(`${what} ${value} is not usable: --user must be a regular, non-root user`);
  return value;
};

/** Writes only when the bytes or the mode differ. Returns whether it wrote. */
function writeIfChanged(path: string, content: string, mode: number): boolean {
  try {
    if (readFileSync(path, "utf8") === content && (lstatSync(path).mode & 0o777) === mode) return false;
  } catch {
    // absent: written below
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return true;
}

const refuseForeignKataConfig = (path: string): void => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink() || !readFileSync(path, "utf8").startsWith(`${KATA_MARKER}\n`))
    throw new CliError(`${path} belongs to another Kata user: refusing to overwrite it`);
};

async function must(deps: VmDeps, cmd: string, args: readonly string[]): Promise<string> {
  const result = await deps.exec(cmd, args);
  if (result.code !== 0) throw new CliError(`${cmd} ${args[0] ?? ""} failed (exit code ${result.code})`);
  return result.stdout;
}

function extract(archive: string, into: string, strip: number): readonly string[] {
  return [
    "-xf",
    archive,
    "-C",
    into,
    "--no-same-owner",
    ...(strip > 0 ? [`--strip-components=${strip}`] : []),
  ];
}

/** The archive extracted beside its destination, then moved over it: a failed extraction keeps the old folder. */
async function installArchive(deps: VmDeps, archive: string, dest: string, strip: number): Promise<void> {
  const staging = `${dest}.pap-staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o755 });
  try {
    await must(deps, "tar", extract(archive, staging, strip));
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** nerdctl-full's `bin/*` go to `/opt/pap-vm/bin` and `libexec/cni` to `/opt/pap-vm/libexec/cni` (pap-vmd's fixed paths, AVM-E36). */
async function installNerdctl(deps: VmDeps, archive: string): Promise<void> {
  const { opt } = deps.roots;
  const staging = join(opt, "nerdctl.pap-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o755 });
  try {
    await must(deps, "tar", extract(archive, staging, 0));
    for (const [from, to] of [
      ["bin", "bin"],
      ["libexec/cni", "libexec/cni"],
    ] as const) {
      if (!existsSync(join(staging, from))) throw new CliError(`the nerdctl-full archive holds no ${from}`);
      mkdirSync(join(opt, to), { recursive: true, mode: 0o755 });
      for (const entry of from === "bin" ? readdirSync(join(staging, from)) : [""]) {
        const target = join(opt, to, entry);
        rmSync(target, { recursive: true, force: true });
        renameSync(join(staging, from, entry), target);
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function installKata(deps: VmDeps, archives: readonly string[], marker: string): Promise<void> {
  const { kata } = deps.roots;
  const staging = `${kata}.pap-staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o755 });
  try {
    for (const archive of archives) await must(deps, "tar", extract(archive, staging, 0));
    if (!existsSync(join(staging, "opt/kata"))) throw new CliError("the Kata archives hold no opt/kata");
    // The marker travels with the folder: a crash after the rename cannot leave /opt/kata looking foreign.
    writeFileSync(join(staging, "opt/kata", SETUP_MARKER), marker);
    rmSync(kata, { recursive: true, force: true });
    renameSync(join(staging, "opt/kata"), kata);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function devSources(deps: VmDeps): Array<readonly [string, string]> {
  const tree = deps.treeRoot;
  if (tree === undefined) throw new CliError("--dev-from-tree needs pap to run from a checkout");
  const { opt } = deps.roots;
  const pairs: Array<readonly [string, string]> = [
    [deps.nodePath, join(opt, "node/bin/node")],
    [join(tree, "packages/pi-host/dist-agent"), join(opt, "agent-bundle")],
  ];
  for (const [source] of [...pairs, [join(tree, "apps/vmd/dist")]] as Array<readonly [string]>)
    if (!existsSync(source)) throw new CliError(`${source} does not exist: run pnpm build first`);
  return pairs;
}

async function firewallHint(deps: VmDeps, io: CliIo): Promise<void> {
  const ufw = await deps.exec("ufw", ["status"]);
  if (ufw.code === 0 && /^Status: active/m.test(ufw.stdout))
    io.stdout.write(
      `ufw is active: allow the agent ports on the bridge with\n  ufw allow in on ${AGENT_NET.bridge} to any port ${AGENT_NET.gatewayPort},${AGENT_NET.relayPort},${AGENT_NET.proxyPort} proto tcp\n`,
    );
  const firewalld = await deps.exec("firewall-cmd", ["--state"]);
  if (firewalld.code === 0 && firewalld.stdout.trim() === "running")
    io.stdout.write(
      `firewalld is running: allow the agent ports on the bridge with\n  firewall-cmd --permanent --zone=trusted --add-interface=${AGENT_NET.bridge} && firewall-cmd --reload\n  (ports ${AGENT_NET.gatewayPort}, ${AGENT_NET.relayPort} and ${AGENT_NET.proxyPort} on ${AGENT_NET.bridge})\n`,
    );
}

interface Group {
  readonly key: string;
  readonly names: readonly AssetName[];
}

/** Which groups of pinned archives this run installs. Dev mode takes node, pap-vmd and the bundle from the tree instead. */
const groups = (dev: boolean): Group[] =>
  [
    { key: "kata", names: ["kata-static", "kata-tools-static"] },
    { key: "nerdctl", names: ["nerdctl-full"] },
    ...(dev
      ? []
      : [
          { key: "node", names: ["node"] },
          { key: "vmd", names: ["pap-vmd"] },
          { key: "agent-bundle", names: ["pap-agent-bundle"] },
        ]),
  ] as Group[];

export async function runSetup(options: SetupOptions, deps: VmDeps, io: CliIo): Promise<number> {
  if (!deps.isRoot) throw new CliError("pap vm setup must run as root: run with sudo");
  if (!options.devFromTree) assertRootOwnedCode(deps.codePaths(), deps.statCode);
  if (options.user === undefined)
    throw new UsageError("vm setup needs --user <name> (the user that runs pap)");
  const user = deps.lookupUser(options.user);
  if (user === undefined) throw new CliError(`no such user: ${options.user}`);
  const uid = checkId("uid", user.uid);
  const gid = checkId("gid", user.gid);
  // M11: the daemon's own home (the unit's PAP_HOME) unless --home says otherwise, so pap-vmd reads the folders pap writes.
  const unitText = deps.readUserUnit(user.home);
  const papHome =
    options.home ?? (unitText === null ? null : parseUnit(unitText)?.home) ?? join(user.home, ".pap");
  if (!isAbsolute(papHome)) throw new CliError("--home must be an absolute path");
  const { roots } = deps;
  let assets: VmAssets = deps.compiled;
  if (options.assets !== undefined) {
    const merged = applyOverrides(deps.compiled, options.assets, deps.openFile);
    assets = merged.assets;
    for (const a of merged.accepted)
      io.stdout.write(`override accepted: ${a.name} ${a.version} ${a.url} sha256:${a.sha256}\n`);
  }
  const shipped = join(roots.kata, PATHS.kataShipped);
  refuseForeign(roots.opt);
  refuseForeign(roots.kata);
  refuseForeignKataConfig(roots.kataConfig);

  const markedOpt = readMarker(roots.opt)?.installed ?? {};
  const markedKata = readMarker(roots.kata)?.installed ?? {};
  const stale = groups(options.devFromTree).filter((group) =>
    group.names.some((name) => (group.key === "kata" ? markedKata : markedOpt)[name] !== assets[name].sha256),
  );
  for (const group of stale)
    for (const name of group.names)
      if (isPlaceholder(assets[name]))
        throw new CliError(
          `${name} is not pinned in this build (placeholder SHA-256): pass --assets <the release's vm-assets.json>`,
        );
  const dev = options.devFromTree ? devSources(deps) : [];

  // Everything is downloaded and checked before the first byte is installed.
  const work = mkdtempSync(join(roots.work, "pap-vm-setup-"));
  let changed = false;
  try {
    const files = new Map<AssetName, string>();
    for (const group of stale)
      for (const name of group.names) {
        const dest = join(work, name);
        await fetchVerified(assets[name] as VmAsset, dest, deps.download);
        files.set(name, dest);
      }
    const file = (name: AssetName): string => files.get(name) as string;

    mkdirSync(roots.opt, { recursive: true, mode: 0o755 });
    if (readMarker(roots.opt) === undefined)
      writeFileSync(join(roots.opt, SETUP_MARKER), '{"installed":{}}\n');
    const installedOpt: Record<string, string> = { ...markedOpt };
    for (const group of stale) {
      if (group.key === "kata") {
        const installedKata = Object.fromEntries(group.names.map((name) => [name, assets[name].sha256]));
        await installKata(deps, group.names.map(file), `${JSON.stringify({ installed: installedKata })}\n`);
      } else if (group.key === "nerdctl") {
        await installNerdctl(deps, file("nerdctl-full"));
        installedOpt["nerdctl-full"] = assets["nerdctl-full"].sha256;
      } else {
        const name = group.names[0] as AssetName;
        const dest = join(roots.opt, group.key);
        await installArchive(deps, file(name), dest, group.key === "node" ? 1 : 0);
        installedOpt[name] = assets[name].sha256;
      }
      changed = true;
    }
    if (options.devFromTree) {
      for (const dir of ["node", "vmd", "agent-bundle"])
        rmSync(join(roots.opt, dir), { recursive: true, force: true });
      for (const [source, dest] of dev) {
        mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
        deps.copyTree(source, dest);
      }
      // pap-vmd with its production dependencies (contracts, zod): the release step's deploy and pruning.
      await deps.deployVmd(deps.treeRoot as string, join(roots.opt, "vmd"));
      for (const name of ["node", "pap-vmd", "pap-agent-bundle"]) Reflect.deleteProperty(installedOpt, name);
      installedOpt["dev-from-tree"] = "tree";
      changed = true;
    }
    // Root ownership and no setuid, setgid or group/other write bit on EVERY run (the Kata marker travels with its folder, so
    // a failed step would otherwise never be retried), then the opt marker: it never names a folder that was not made safe.
    await must(deps, "chown", ["-R", "0:0", roots.opt, roots.kata]);
    await must(deps, "chmod", ["-R", "u-s,g-s,go-w", roots.opt, roots.kata]);
    if (changed) {
      if (!options.devFromTree) Reflect.deleteProperty(installedOpt, "dev-from-tree");
      writeFileSync(join(roots.opt, SETUP_MARKER), `${JSON.stringify({ installed: installedOpt })}\n`);
    }

    if (!existsSync(shipped)) throw new CliError(`the Kata archives hold no ${PATHS.kataShipped}`);
    const writes = [
      writeIfChanged(join(roots.opt, "bin", PATHS.shimWrapper), shimWrapper(), 0o755),
      writeIfChanged(join(roots.etc, "config.json"), vmdConfig({ uid, gid, home: papHome }), 0o644),
      writeIfChanged(join(roots.etc, "containerd.toml"), containerdToml(), 0o644),
      writeIfChanged(join(roots.etc, "buildkitd.toml"), buildkitdToml(), 0o644),
      writeIfChanged(join(roots.etc, "agents.nft"), agentNetRuleset(), 0o644),
      writeIfChanged(join(roots.etc, "cni", `${AGENT_NET.network}.conflist`), conflist(), 0o644),
      writeIfChanged(roots.kataConfig, kataConfig(readFileSync(shipped, "utf8")), 0o644),
      ...UNIT_NAMES.map((name) => writeIfChanged(join(roots.units, name), UNIT_FILES[name](), 0o644)),
    ];
    if (changed || writes.includes(true)) {
      await must(deps, "systemctl", ["daemon-reload"]);
      await must(deps, "systemctl", ["enable", ...UNIT_NAMES]);
      io.stdout.write("restarting the pap-vm units: running agent VMs may be stopped\n");
      await must(deps, "systemctl", ["restart", ...UNIT_NAMES]);
      io.stdout.write("pap vm setup done\n");
    } else io.stdout.write("pap vm setup: nothing to change\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (options.devFromTree) io.stdout.write(`${DEV_RESIDUAL}\n`);
  await firewallHint(deps, io);
  return 0;
}

export const vmSetup: Command = {
  options: {
    user: { type: "string" },
    home: { type: "string" },
    assets: { type: "string" },
    "dev-from-tree": { type: "boolean" },
  },
  run({ values, positionals, io }) {
    if (positionals.length > 0) throw new UsageError("vm setup takes no argument");
    const text = (key: string): string | undefined =>
      typeof values[key] === "string" ? values[key] : undefined;
    return runSetup(
      {
        user: text("user"),
        home: text("home"),
        assets: text("assets"),
        devFromTree: values["dev-from-tree"] === true,
      },
      realDeps(),
      io,
    );
  },
};
