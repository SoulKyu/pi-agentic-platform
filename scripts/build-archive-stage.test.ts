import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { putAgentBundle } from "./agent-bundle-fixture.ts";
import { AGENT_BUNDLE } from "./build-agent-bundle.ts";
import { DIST_DIRS, stageTree } from "./build-archive-stage.ts";
import { putLicences } from "./licence-fixture.ts";

/* Mutants, each run for real: the bundle copy removed ("ships the agent bundle"); `verbatimSymlinks` dropped ("keeps a relative link"); the bundle check removed ("refuses"). */
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const fixture = (): { repo: string; app: string } => {
  const root = mkdtempSync(join(tmpdir(), "pap-stage-"));
  roots.push(root);
  const repo = join(root, "repo");
  put(join(repo, "package.json"), '{"name":"root"}');
  put(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
  put(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  putLicences(repo);
  for (const dir of DIST_DIRS) {
    put(join(repo, dir, "package.json"), `{"name":"${dir}"}`);
    put(join(repo, dir, "dist/main.js"), "export {};");
  }
  putAgentBundle(join(repo, AGENT_BUNDLE));
  put(join(repo, AGENT_BUNDLE, "node_modules/dep/index.js"), "export {};");
  put(join(repo, AGENT_BUNDLE, "node_modules/dep/1.0.0/index.js"), "export {};");
  symlinkSync("1.0.0", join(repo, AGENT_BUNDLE, "node_modules/dep/current"));
  return { repo, app: join(root, "app") };
};
const run = () => Promise.resolve();

describe("stageTree and the agent bundle (AVM-P20)", () => {
  it("ships the agent bundle with dist/guest/main.js and dist/relay/main.js", async () => {
    const { repo, app } = fixture();
    await stageTree({ repo, app, run });
    for (const file of ["dist/guest/main.js", "dist/relay/main.js", "package.json"])
      expect(existsSync(join(app, AGENT_BUNDLE, file)), file).toBe(true);
    expect(readFileSync(join(app, AGENT_BUNDLE, "node_modules/dep/package.json"), "utf8")).toContain("dep");
  });

  it("keeps a relative link as a relative link", async () => {
    const { repo, app } = fixture();
    await stageTree({ repo, app, run });
    expect(readlinkSync(join(app, AGENT_BUNDLE, "node_modules/dep/current"))).toBe("1.0.0");
  });

  it("refuses a repository without the bundle", async () => {
    const { repo, app } = fixture();
    rmSync(join(repo, AGENT_BUNDLE), { recursive: true });
    await expect(stageTree({ repo, app, run })).rejects.toThrow(/run pnpm build first/);
  });

  it("refuses a bundle with a link that leaves it", async () => {
    const { repo, app } = fixture();
    symlinkSync("../../../..", join(repo, AGENT_BUNDLE, "node_modules/dep/up"));
    await expect(stageTree({ repo, app, run })).rejects.toThrow(/node_modules\/dep\/up/);
  });
});
