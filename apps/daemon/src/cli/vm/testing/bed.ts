import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cliIo } from "../../testing/cli-io.ts";
import { ASSET_NAMES, parseAssets, type AssetName, type VmAssets } from "../assets.ts";
import { PATHS } from "../configs.ts";
import type { Exec, VmDeps, VmRoots } from "../deps.ts";

export const SHIPPED_KATA = [
  "[hypervisor.cloud-hypervisor]",
  "default_vcpus = 1",
  "default_memory = 2048",
  'shared_fs = "virtio-fs"',
  "[runtime]",
  "static_sandbox_resource_mgmt = false",
  "",
].join("\n");

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** What the fake `tar` leaves in the folder it extracts into, per archive (named like the asset). */
const MEMBERS: Record<AssetName, Array<[string, string]>> = {
  "kata-static": [
    [`opt/kata/${PATHS.kataShipped}`, SHIPPED_KATA],
    ["opt/kata/runtime-rs/bin/containerd-shim-kata-v2", "shim"],
  ],
  "kata-tools-static": [["opt/kata/bin/kata-ctl", "ctl"]],
  "nerdctl-full": [
    ["bin/nerdctl", "n"],
    ["libexec/cni/bridge", "b"],
  ],
  node: [["bin/node", "node"]],
  "pap-vmd": [["dist/main.js", "vmd"]],
  "pap-agent-bundle": [["dist/guest/main.js", "g"]],
};

export const payload = (name: string): string => `payload of ${name}`;

/** Every file under `dir` with its content (links as their target), sorted: the tree to compare before and after. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length)] = entry.isDirectory()
      ? "<dir>"
      : lstatSync(path).isSymbolicLink()
        ? "<link>"
        : readFileSync(path, "utf8");
  }
  return Object.fromEntries(Object.entries(out).sort());
}

export function makeBed(overrides: { tamper?: AssetName; ufw?: string; noTree?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pap-vm-bed-"));
  const roots: VmRoots = {
    opt: join(root, "opt/pap-vm"),
    kata: join(root, "opt/kata"),
    etc: join(root, "etc/pap-vm"),
    state: join(root, "var/pap-vm"),
    kataConfig: join(root, "etc/kata-containers/runtime-rs/configuration.toml"),
    units: join(root, "etc/systemd/system"),
    work: join(root, "work"),
  };
  for (const dir of [join(root, "opt"), roots.units, roots.work, roots.state])
    mkdirSync(dir, { recursive: true });
  const tree = join(root, "tree");
  put(join(tree, "apps/vmd/dist/main.js"), "dev vmd");
  put(join(tree, "apps/vmd/package.json"), "{}");
  put(join(tree, "packages/contracts/dist/index.js"), "c");
  put(join(tree, "packages/contracts/package.json"), "{}");
  put(join(tree, "packages/pi-host/dist-agent/dist/guest/main.js"), "dev guest");
  put(join(root, "running-node"), "running node");

  const assets: VmAssets = parseAssets({
    assets: ASSET_NAMES.map((name) => ({
      name,
      version: "1.0.0",
      url: `https://example.invalid/${name}`,
      sha256: createHash("sha256").update(payload(name)).digest("hex"),
    })),
    baseImages: [],
  });
  const calls: string[] = [];
  const downloads: string[] = [];
  const copies: Array<[string, string]> = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "tar") {
      const into = args[args.indexOf("-C") + 1] as string;
      const name = basename(args[1] as string) as AssetName;
      for (const [file, text] of MEMBERS[name]) put(join(into, file), text);
    }
    if (cmd === "ufw")
      return Promise.resolve({ code: overrides.ufw === undefined ? 127 : 0, stdout: overrides.ufw ?? "" });
    return Promise.resolve({ code: cmd === "firewall-cmd" ? 127 : 0, stdout: "" });
  };
  const deps: VmDeps = {
    roots,
    exec,
    isRoot: true,
    copyTree: (source, destination) => {
      copies.push([source, destination]);
      cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    },
    lookupUser: (name) =>
      name === "pap"
        ? { uid: 1001, gid: 1002, home: "/home/pap" }
        : name === "root"
          ? { uid: 0, gid: 0, home: "/root" }
          : undefined,
    loadAssets: () => assets,
    download: (asset, dest) => {
      downloads.push(asset.name);
      writeFileSync(dest, asset.name === overrides.tamper ? "tampered" : payload(asset.name));
      return Promise.resolve();
    },
    nodePath: join(root, "running-node"),
    treeRoot: overrides.noTree ? undefined : tree,
  };
  const { io, stdout } = cliIo();
  return {
    root,
    roots,
    deps,
    io,
    stdout,
    calls,
    downloads,
    copies,
    tree,
    assets,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
