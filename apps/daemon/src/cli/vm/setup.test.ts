import { agentNetRuleset } from "@pap/contracts";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../open-home.ts";
import { UsageError } from "../usage.ts";
import { DEV_RESIDUAL, SETUP_MARKER, runSetup, type SetupOptions } from "./setup.ts";
import { conflist, KATA_MARKER } from "./configs.ts";
import { makeBed, payload, snapshot } from "./testing/bed.ts";

/*
 * Fix round 1 mutants: the chmod step removed ("makes everything root-owned...", "strips setuid..."); the owner check of
 * --assets removed and a Kata override accepted (assets.test.ts "--assets" cases, setup "prints every accepted override").
 * Mutants, each run for real (a guard removed, the named case fails):
 * - SHA check skipped (fetchVerified compares nothing): "stops on a SHA-256 mismatch before anything is installed",
 *   "checks every archive before installing the first one".
 * - a tree file copied without --dev-from-tree (the release branch calls copyTree): "copies no file of the running tree
 *   without --dev-from-tree".
 * - ExecStart outside /opt/pap-vm: units.test.ts "every ExecStart is under /opt/pap-vm" and the written-units case below.
 * - a Kata key set without its existence check: configs.test.ts "stops naming a key the shipped file lacks".
 * - uninstall removing a Kata config not starting with pap's line: uninstall.test.ts "leaves a Kata config that is no longer pap's".
 * - refuseForeignKataConfig removed: "refuses to overwrite a Kata config it did not write" (file and link cases).
 */
const beds: Array<ReturnType<typeof makeBed>> = [];
afterEach(() => {
  for (const bed of beds.splice(0)) bed.cleanup();
});
const bed = (overrides: Parameters<typeof makeBed>[0] = {}) => {
  const made = makeBed(overrides);
  beds.push(made);
  return made;
};
const opts = (extra: Partial<SetupOptions> = {}): SetupOptions => ({
  user: "pap",
  home: undefined,
  assets: undefined,
  devFromTree: false,
  ...extra,
});

// S1 item 2 mutants: M-a chown/chmod only inside `if (changed)` (the old shape): "retries a failed chmod on the next run";
// M-b the opt marker written before chown/chmod: "lists nothing in the opt marker when chmod failed on the first run".
describe("pap vm setup: refusals", () => {
  it("refuses a non-root caller with the sudo hint", async () => {
    const b = bed();
    await expect(runSetup(opts(), { ...b.deps, isRoot: false }, b.io)).rejects.toThrow(/run with sudo/);
    expect(b.calls).toEqual([]);
  });

  it("refuses without --user (R36), an unknown user and root", async () => {
    const b = bed();
    await expect(runSetup(opts({ user: undefined }), b.deps, b.io)).rejects.toBeInstanceOf(UsageError);
    await expect(runSetup(opts({ user: "ghost" }), b.deps, b.io)).rejects.toThrow(/no such user/);
    await expect(runSetup(opts({ user: "root" }), b.deps, b.io)).rejects.toThrow(/non-root/);
    expect(existsSync(b.roots.opt)).toBe(false);
  });

  it("stops on a SHA-256 mismatch before anything is installed", async () => {
    const b = bed({ tamper: "kata-static" });
    await expect(runSetup(opts(), b.deps, b.io)).rejects.toThrow(/kata-static: SHA-256 mismatch/);
    expect(b.calls.filter((c) => c.startsWith("tar"))).toEqual([]);
    expect(existsSync(b.roots.opt)).toBe(false);
    expect(existsSync(b.roots.etc)).toBe(false);
  });

  it("checks every archive before installing the first one", async () => {
    const b = bed({ tamper: "pap-agent-bundle" });
    await expect(runSetup(opts(), b.deps, b.io)).rejects.toThrow(/pap-agent-bundle: SHA-256 mismatch/);
    expect(b.calls.filter((c) => c.startsWith("tar"))).toEqual([]);
    expect(existsSync(b.roots.kata)).toBe(false);
    expect(existsSync(b.roots.opt)).toBe(false);
  });

  it("refuses a /opt/kata or /opt/pap-vm it did not make", async () => {
    for (const dir of ["kata", "opt"] as const) {
      const b = bed();
      mkdirSync(b.roots[dir], { recursive: true });
      writeFileSync(join(b.roots[dir], "foreign"), "x");
      await expect(runSetup(opts(), b.deps, b.io)).rejects.toThrow(/not made by pap vm setup/);
      expect(b.downloads).toEqual([]);
      expect(snapshot(b.roots[dir])).toEqual({ "/foreign": "x" });
    }
  });

  it("refuses to overwrite a Kata config it did not write (file and link)", async () => {
    for (const kind of ["file", "link"] as const) {
      const b = bed();
      mkdirSync(dirname(b.roots.kataConfig), { recursive: true });
      if (kind === "file") writeFileSync(b.roots.kataConfig, "# another user\n");
      else {
        writeFileSync(join(b.root, "target.toml"), `${KATA_MARKER}\n`);
        symlinkSync(join(b.root, "target.toml"), b.roots.kataConfig);
      }
      await expect(runSetup(opts(), b.deps, b.io)).rejects.toThrow(/another Kata user/);
      expect(b.downloads).toEqual([]);
      expect(
        kind === "file"
          ? readFileSync(b.roots.kataConfig, "utf8")
          : lstatSync(b.roots.kataConfig).isSymbolicLink(),
      ).toBe(kind === "file" ? "# another user\n" : true);
    }
  });

  it("refuses a placeholder SHA-256", async () => {
    const b = bed();
    const assets = { ...b.assets, node: { ...b.assets.node, sha256: "0".repeat(64) } };
    await expect(runSetup(opts(), { ...b.deps, compiled: assets }, b.io)).rejects.toThrow(/not pinned/);
    expect(b.calls).toEqual([]);
    expect(b.downloads).toEqual([]);
  });
});

describe("pap vm setup: install", () => {
  it("installs from the pinned archives and copies no file of the running tree without --dev-from-tree", async () => {
    const b = bed();
    expect(await runSetup(opts(), b.deps, b.io)).toBe(0);
    expect(b.copies).toEqual([]);
    expect(readFileSync(join(b.roots.opt, "node/bin/node"), "utf8")).toBe("node");
    expect(readFileSync(join(b.roots.opt, "vmd/dist/main.js"), "utf8")).toBe("vmd");
    expect(existsSync(join(b.roots.opt, "agent-bundle/dist/guest/main.js"))).toBe(true);
    expect(existsSync(join(b.roots.opt, "libexec/cni/bridge"))).toBe(true);
    expect(readFileSync(join(b.roots.opt, "bin/nerdctl"), "utf8")).toBe("n");
    expect(existsSync(join(b.roots.opt, "nerdctl"))).toBe(false);
    expect(existsSync(join(b.roots.kata, "bin/kata-ctl"))).toBe(true);
    expect(existsSync(join(b.roots.opt, "node.pap-staging"))).toBe(false);
    expect(b.stdout()).not.toContain(DEV_RESIDUAL);
    expect(b.calls.filter((c) => c.startsWith("tar")).every((c) => c.includes("--no-same-owner"))).toBe(true);
    expect(b.calls.filter((c) => c.startsWith("systemctl"))).toEqual([
      "systemctl daemon-reload",
      "systemctl enable pap-vm-containerd.service pap-vm-buildkit.service pap-vmd.service",
      "systemctl restart pap-vm-containerd.service pap-vm-buildkit.service pap-vmd.service",
    ]);
  });

  it("makes everything root-owned without group/other write or setuid bits, then writes the marker (chmod)", async () => {
    const b = bed({ setuid: true });
    await runSetup(opts(), b.deps, b.io);
    const last = b.calls.filter((c) => c.startsWith("tar")).length;
    expect(last).toBe(6);
    const at = (prefix: string) => b.calls.findIndex((c) => c.startsWith(prefix));
    expect(b.calls).toContain(`chown -R 0:0 ${b.roots.opt} ${b.roots.kata}`);
    expect(b.calls).toContain(`chmod -R u-s,g-s,go-w ${b.roots.opt} ${b.roots.kata}`);
    expect(at("chown")).toBeGreaterThan(
      b.calls.map((c, i) => (c.startsWith("tar") ? i : -1)).reduce((a, c) => Math.max(a, c)),
    );
    expect(statSync(join(b.roots.kata, "bin/kata-ctl")).mode & 0o7022).toBe(0);
    expect(
      JSON.parse(readFileSync(join(b.roots.kata, SETUP_MARKER), "utf8")).installed["kata-static"],
    ).toBeTypeOf("string");
    expect(JSON.parse(readFileSync(join(b.roots.opt, SETUP_MARKER), "utf8")).installed.node).toBeTypeOf(
      "string",
    );
  });

  it("warns that running agent VMs may be stopped before it restarts the units", async () => {
    const b = bed();
    await runSetup(opts(), b.deps, b.io);
    expect(b.stdout()).toContain("running agent VMs may be stopped");
  });

  it("prints every override --assets gave, with name, version, URL and SHA-256, before installing", async () => {
    const b = bed();
    const entry = { ...b.assets["pap-vmd"], version: "9.9.9", sha256: "c".repeat(64) };
    const deps = {
      ...b.deps,
      compiled: { ...b.assets, "pap-vmd": { ...entry, version: "0.0.0", sha256: "0".repeat(64) } },
      openFile: () => ({
        isFile: true,
        uid: 0,
        mode: 0o100644,
        text: JSON.stringify({ assets: Object.values({ ...b.assets, "pap-vmd": entry }), baseImages: [] }),
      }),
      download: (a: { name: string }, dest: string) => b.deps.download(a as never, dest),
    };
    await expect(runSetup(opts({ assets: "/x/vm-assets.json" }), deps, b.io)).rejects.toThrow(
      /SHA-256 mismatch/,
    );
    expect(b.stdout()).toContain(`override accepted: pap-vmd 9.9.9 ${entry.url} sha256:${"c".repeat(64)}`);
    expect(b.calls.filter((c) => c.startsWith("tar"))).toEqual([]);
  });

  it("writes config.json with the uid, gid and home of --user, and the home given", async () => {
    const b = bed();
    await runSetup(opts(), b.deps, b.io);
    const file = join(b.roots.etc, "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      papUid: 1001,
      papGid: 1002,
      papHome: "/home/pap/.pap",
    });
    await runSetup(opts({ home: "/srv/pap" }), b.deps, b.io);
    expect(JSON.parse(readFileSync(file, "utf8")).papHome).toBe("/srv/pap");
    await expect(runSetup(opts({ home: "rel" }), b.deps, b.io)).rejects.toBeInstanceOf(CliError);
  });

  it("writes the configs, the ruleset, the conflist, the shim wrapper and the Kata override", async () => {
    const b = bed();
    await runSetup(opts(), b.deps, b.io);
    expect(readFileSync(join(b.roots.etc, "agents.nft"), "utf8")).toBe(agentNetRuleset());
    expect(readFileSync(join(b.roots.etc, "cni/pap-agents.conflist"), "utf8")).toBe(conflist());
    expect(readFileSync(join(b.roots.etc, "containerd.toml"), "utf8")).toContain(
      'address = "/run/pap-vm/containerd.sock"',
    );
    const buildkit = readFileSync(join(b.roots.etc, "buildkitd.toml"), "utf8");
    expect(buildkit).toContain('namespace = "pap"');
    expect(buildkit).toMatch(/\[worker\.oci\]\n {2}enabled = false/);
    const shim = join(b.roots.opt, "bin/containerd-shim-kata-clh-v2");
    expect(readFileSync(shim, "utf8")).toBe(
      '#!/bin/sh\nexec /opt/kata/runtime-rs/bin/containerd-shim-kata-v2 "$@"\n',
    );
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    const kata = readFileSync(b.roots.kataConfig, "utf8");
    expect(kata.split("\n")[0]).toBe(KATA_MARKER);
    expect(kata).toContain("default_memory = 256\n");
    expect(kata).toContain("default_vcpus = 1\n");
    expect(kata).toContain("static_sandbox_resource_mgmt = true\n");
  });

  it("writes the three units with ExecStart under /opt/pap-vm only", async () => {
    const b = bed();
    await runSetup(opts(), b.deps, b.io);
    for (const name of ["pap-vm-containerd.service", "pap-vm-buildkit.service", "pap-vmd.service"]) {
      const text = readFileSync(join(b.roots.units, name), "utf8");
      const starts = text.split("\n").filter((l) => l.startsWith("ExecStart="));
      expect(starts).toHaveLength(1);
      expect(starts.every((l) => l.startsWith("ExecStart=/opt/pap-vm/"))).toBe(true);
    }
  });

  it("retries a failed chmod on the next run, and writes the marker only after it", async () => {
    const b = bed({ setuid: true });
    await runSetup(opts(), b.deps, b.io);
    // A new Kata pin alone: the Kata marker is written with the staged folder, the opt marker is not stale.
    const next = {
      ...b.deps,
      compiled: {
        ...b.assets,
        "kata-static": {
          ...b.assets["kata-static"],
          sha256: createHash("sha256").update("v2").digest("hex"),
        },
      },
      download: (asset: { name: string }, dest: string) => {
        writeFileSync(dest, asset.name === "kata-static" ? "v2" : payload(asset.name));
        return Promise.resolve();
      },
    };
    b.failNextChmod();
    await expect(runSetup(opts(), next as never, b.io)).rejects.toThrow(/chmod/);
    b.calls.length = 0;
    await runSetup(opts(), next as never, b.io);
    // The Kata marker already names the new pin, yet its folder is made safe now.
    expect(b.calls.filter((c) => c.startsWith("chmod"))).toEqual([
      `chmod -R u-s,g-s,go-w ${b.roots.opt} ${b.roots.kata}`,
    ]);
    expect(statSync(join(b.roots.kata, "bin/kata-ctl")).mode & 0o7022).toBe(0);
  });

  it("lists nothing in the opt marker when chmod failed on the first run", async () => {
    const b = bed();
    b.failNextChmod();
    await expect(runSetup(opts(), b.deps, b.io)).rejects.toThrow(/chmod/);
    expect(JSON.parse(readFileSync(join(b.roots.opt, SETUP_MARKER), "utf8")).installed).toEqual({});
  });

  it("does nothing on a second run: no download, no tar, no systemctl, no rewrite", async () => {
    const b = bed();
    await runSetup(opts(), b.deps, b.io);
    const before = snapshot(b.root);
    const mtime = statSync(join(b.roots.etc, "config.json")).mtimeMs;
    b.calls.length = 0;
    b.downloads.length = 0;
    await runSetup(opts(), b.deps, b.io);
    expect(b.downloads).toEqual([]);
    expect(b.calls.filter((c) => !/^(ufw|firewall-cmd|chown|chmod)/.test(c))).toEqual([]);
    expect(snapshot(b.root)).toEqual(before);
    expect(statSync(join(b.roots.etc, "config.json")).mtimeMs).toBe(mtime);
    expect(b.stdout()).toContain("nothing to change");
  });

  it("prints the firewall rule for 7841 and 7842 only when ufw is active", async () => {
    const active = bed({ ufw: "Status: active\n" });
    await runSetup(opts(), active.deps, active.io);
    expect(active.stdout()).toContain("ufw allow in on pap0 to any port 7841,7842 proto tcp");
    const quiet = bed({ ufw: "Status: inactive\n" });
    await runSetup(opts(), quiet.deps, quiet.io);
    expect(quiet.stdout()).not.toContain("ufw allow");
  });
});

describe("pap vm setup --dev-from-tree", () => {
  it("deploys pap-vmd with its dependencies, copies the bundle and the running Node, and prints the residual", async () => {
    const b = bed();
    await runSetup(opts({ devFromTree: true }), b.deps, b.io);
    expect(b.downloads).not.toContain("node");
    expect(b.downloads).not.toContain("pap-vmd");
    expect(b.copies.map(([source]) => source)).toEqual([
      b.deps.nodePath,
      join(b.tree, "packages/pi-host/dist-agent"),
    ]);
    expect(b.deploys).toEqual([[b.tree, join(b.roots.opt, "vmd")]]);
    expect(existsSync(join(b.roots.opt, "vmd/node_modules/zod/package.json"))).toBe(true);
    expect(readFileSync(join(b.roots.opt, "node/bin/node"), "utf8")).toBe("running node");
    expect(readFileSync(join(b.roots.opt, "vmd/dist/main.js"), "utf8")).toBe("dev vmd");
    expect(readFileSync(join(b.roots.opt, "agent-bundle/dist/guest/main.js"), "utf8")).toBe("dev guest");
    expect(b.stdout()).toContain("Code your user can change will run as root (testing only).");
    expect(JSON.parse(readFileSync(join(b.roots.opt, SETUP_MARKER), "utf8")).installed["dev-from-tree"]).toBe(
      "tree",
    );
  });

  it("refuses outside a checkout and when the tree is not built", async () => {
    const none = bed({ noTree: true });
    await expect(runSetup(opts({ devFromTree: true }), none.deps, none.io)).rejects.toThrow(/checkout/);
    const unbuilt = bed();
    await expect(
      runSetup(opts({ devFromTree: true }), { ...unbuilt.deps, treeRoot: unbuilt.root }, unbuilt.io),
    ).rejects.toThrow(/pnpm build/);
    expect(existsSync(unbuilt.roots.opt)).toBe(false);
  });
});
