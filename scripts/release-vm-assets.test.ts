import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256File } from "../apps/daemon/src/cli/vm/assets.ts";
import { putAgentBundle } from "./agent-bundle-fixture.ts";
import { AGENT_BUNDLE } from "./build-agent-bundle.ts";
import { buildVmArtefacts, buildVmdFolder, type VmArtefactOptions } from "./release-vm-assets.ts";

/* Mutant: the vm-assets.json hash taken from the wrong tarball (vmd hash written for the bundle). Killed by "writes both
   SHA-256 into vm-assets.json". Mutant: the deploy run without --offline is the build-agent-bundle test's. */
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const setup = (withVmd = true) => {
  const repo = mkdtempSync(join(tmpdir(), "pap-release-vm-"));
  roots.push(repo);
  const dir = join(repo, "out");
  mkdirSync(dir);
  cpSync(
    join(import.meta.dirname, "../apps/daemon/src/cli/vm/vm-assets.json"),
    join(repo, "apps/daemon/src/cli/vm/vm-assets.json"),
    { recursive: true },
  );
  if (withVmd) put(join(repo, "apps/vmd/package.json"), '{"name":"@pap/vmd"}');
  putAgentBundle(join(repo, AGENT_BUNDLE));
  const calls: Array<{ cmd: string; args: readonly string[]; cwd: string }> = [];
  const run: VmArtefactOptions["run"] = (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    if (cmd === "pnpm") {
      const dest = args.at(-1) as string;
      put(join(dest, "package.json"), '{"name":"@pap/vmd","version":"1.2.3","type":"module"}');
      put(join(dest, "dist/main.js"), "export {};\n");
      put(join(dest, "src/main.ts"), "export {};\n");
      put(join(dest, "node_modules/@pap/contracts/package.json"), "{}");
      put(join(dest, "node_modules/@pap/contracts/dist/index.js"), "export {};\n");
      put(join(dest, "node_modules/zod/package.json"), '{"name":"zod"}');
    } else {
      const archive = args[args.indexOf("-czf") + 1] as string;
      writeFileSync(archive, `tar of ${args.at(-1)} from ${cwd.split("/").pop()}`);
    }
    return Promise.resolve();
  };
  const options: VmArtefactOptions = {
    repo,
    run,
    storeDir: "/store",
    dir,
    tag: "v1.2.3",
    version: "1.2.3",
    feedRepo: "SoulKyu/pi-agentic-platform",
    sha256: sha256File,
  };
  return { repo, dir, calls, options };
};

describe("buildVmArtefacts", () => {
  it("writes both SHA-256 into vm-assets.json and keeps the other pins", async () => {
    const t = setup();
    await buildVmArtefacts(t.options);
    const file = JSON.parse(readFileSync(join(t.dir, "vm-assets.json"), "utf8")) as {
      assets: Array<{ name: string; version: string; url: string; sha256: string }>;
    };
    const by = Object.fromEntries(file.assets.map((a) => [a.name, a]));
    expect(by["pap-vmd"]?.sha256).toBe(await sha256File(join(t.dir, "pap-vmd-1.2.3.tar.gz")));
    expect(by["pap-agent-bundle"]?.sha256).toBe(
      await sha256File(join(t.dir, "pap-agent-bundle-1.2.3.tar.gz")),
    );
    expect(by["pap-vmd"]?.sha256).not.toBe(by["pap-agent-bundle"]?.sha256);
    expect(by["pap-vmd"]?.url).toBe(
      "https://github.com/SoulKyu/pi-agentic-platform/releases/download/v1.2.3/pap-vmd-1.2.3.tar.gz",
    );
    expect(by["pap-vmd"]?.version).toBe("1.2.3");
    expect(by["kata-static"]?.sha256).toBe(
      "b828904fa3f1e49ddd7dc799c72cb1503cd1e772d354c3987c8d4189b2a623a8",
    );
  });

  it("deploys @pap/vmd offline like the agent bundle, prunes it and packs it reproducibly", async () => {
    const t = setup();
    await buildVmArtefacts(t.options);
    const deploy = t.calls.find((c) => c.cmd === "pnpm");
    expect(deploy?.args).toEqual(
      expect.arrayContaining([
        "--filter",
        "@pap/vmd",
        "deploy",
        "--prod",
        "--offline",
        "--store-dir",
        "/store",
      ]),
    );
    const tars = t.calls.filter((c) => c.cmd === "tar");
    expect(tars).toHaveLength(2);
    for (const tar of tars)
      expect(tar.args).toEqual(
        expect.arrayContaining(["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0"]),
      );
    expect(existsSync(join(t.repo, "apps/vmd/.release-building"))).toBe(false);
  });

  it("builds the dev pap-vmd folder with the same deploy: @pap/vmd, contracts and zod, pruned", async () => {
    const t = setup();
    const dest = join(t.repo, "dev-vmd");
    await buildVmdFolder(t.options, dest);
    expect(t.calls[0]?.args).toEqual(
      expect.arrayContaining(["--filter", "@pap/vmd", "deploy", "--prod", "--offline"]),
    );
    expect(existsSync(join(dest, "node_modules/zod/package.json"))).toBe(true);
    expect(existsSync(join(dest, "node_modules/@pap/contracts/dist/index.js"))).toBe(true);
    expect(existsSync(join(dest, "src"))).toBe(false);
  });

  it("fails closed when apps/vmd is missing or the deployed folder lacks its entry", async () => {
    const none = setup(false);
    await expect(buildVmArtefacts(none.options)).rejects.toThrow(/apps\/vmd does not exist/);
    expect(existsSync(join(none.dir, "vm-assets.json"))).toBe(false);
    const t = setup();
    const run: VmArtefactOptions["run"] = (cmd, args, cwd) =>
      t.options.run(cmd, args, cwd).then(() => {
        if (cmd === "pnpm") rmSync(join(args.at(-1) as string, "dist/main.js"));
      });
    await expect(buildVmArtefacts({ ...t.options, run })).rejects.toThrow(/dist\/main\.js/);
    expect(existsSync(join(t.dir, "vm-assets.json"))).toBe(false);
  });
});
