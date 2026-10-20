import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProfileContext } from "../apps/daemon/src/modules/agent-vm/image-inputs.ts";
import { imageEntriesOf } from "../apps/daemon/src/modules/agent-vm/pick-map.ts";
import { pickPackages, seedAgentFolder } from "../packages/pi-host/src/guest/seed.ts";

/*
 * AVM-E42 I1. The image rewrites the entries it writes (`npm:name` becomes `npm:name@<installed>`, a git URL becomes `git:host/path`,
 * a local path becomes `local/<name>`), and the guest narrows the image's list by equality. A pick must therefore be mapped from the
 * exact `settings.json` spelling to the entry the image wrote. Mutant: the picks go to the guest as the exact spellings -> "all three
 * survive" fails (the VM's settings hold none of them).
 */
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const BASE = `pap-agent-base-${"1".repeat(64)}`;
const SOURCES = ["npm:left-pad", "https://github.com/acme/tools.git", "../local-tool"];

function built() {
  const root = mkdtempSync(join(tmpdir(), "pap-pick-image-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const put = (rel: string, text: string): void => {
    mkdirSync(join(agentDir, rel, ".."), { recursive: true });
    writeFileSync(join(agentDir, rel), text);
  };
  put("settings.json", JSON.stringify({ packages: SOURCES }));
  put("npm/node_modules/left-pad/package.json", JSON.stringify({ name: "left-pad", version: "1.3.0" }));
  put("git/github.com/acme/tools/package.json", JSON.stringify({ name: "tools", version: "1.0.0" }));
  mkdirSync(join(root, "local-tool"), { recursive: true });
  writeFileSync(
    join(root, "local-tool", "package.json"),
    JSON.stringify({ name: "local-tool", version: "0.1.0" }),
  );
  const out = join(root, "image");
  const profile = prepareProfileContext(agentDir, out, [], join(root, "pap-home"), BASE);
  const piAgentDir = join(root, "vm", ".pi", "agent");
  const layout: Parameters<typeof seedAgentFolder>[0] = {
    root: join(root, "vm"),
    home: join(root, "vm", "home"),
    knowledge: join(root, "vm", "knowledge"),
    inbox: join(root, "vm", "inbox"),
    pi: join(root, "vm", ".pi"),
    sessions: join(root, "vm", ".pi", "sessions"),
    piAgentDir,
    imageAgentDir: out,
    shellOverlay: join(root, "overlay"),
  };
  mkdirSync(layout.root, { recursive: true });
  seedAgentFolder(layout);
  return {
    profile,
    layout,
    settings: () =>
      JSON.parse(readFileSync(join(piAgentDir, "settings.json"), "utf8")) as { packages: unknown[] },
  };
}

describe("a plugin pick reaches the VM (I1)", () => {
  it("the image records which entry it wrote for each source", () => {
    const { profile } = built();
    expect(profile.written).toEqual([
      { source: "npm:left-pad", written: "npm:left-pad@1.3.0" },
      { source: "https://github.com/acme/tools.git", written: "git:github.com/acme/tools" },
      { source: "../local-tool", written: "local/local-tool" },
    ]);
  });

  it("an unpinned npm package, an https git source and a local path all survive into the VM's settings", () => {
    const { profile, layout, settings } = built();
    const mapped = imageEntriesOf(SOURCES, profile.written);
    expect(mapped.missing).toEqual([]);
    pickPackages(layout, mapped.entries);
    expect(settings().packages).toEqual([
      "npm:left-pad@1.3.0",
      "git:github.com/acme/tools",
      "local/local-tool",
    ]);
  });

  it("a pick the image did not write is reported, never dropped silently, and the others still arrive", () => {
    const { profile, layout, settings } = built();
    const mapped = imageEntriesOf(["npm:left-pad", "npm:never-installed"], profile.written);
    expect(mapped.missing).toEqual(["npm:never-installed"]);
    pickPackages(layout, mapped.entries);
    expect(settings().packages).toEqual(["npm:left-pad@1.3.0"]);
  });
});
