import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { checkEditTarget } from "./target-path.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

describe("checkEditTarget: names that run code later (M5R30)", () => {
  it.each([
    ".idea/workspace.xml",
    ".zed/tasks.json",
    ".devcontainer/devcontainer.json",
    "mise.toml",
    ".mise.toml",
    ".MISE.TOML",
    "lefthook.yml",
    "lefthook.yaml",
    "lefthook.toml",
    "lefthook.json",
    ".lefthook.yml",
    ".lefthook.yaml",
    ".lefthook.toml",
    ".lefthook.json",
    ".config/lefthook.yml",
    ".config/lefthook.json",
    "lefthook-local.yml",
    "lefthook-local.yaml",
    "lefthook-local.toml",
    "lefthook-local.json",
    ".lefthook-local.yml",
    ".lefthook-local.json",
    ".config/lefthook-local.toml",
    "mise.local.toml",
    ".mise.local.toml",
    "mise.production.toml",
    ".mise.staging.toml",
    ".mise/config.toml",
    "mise/config.toml",
    ".config/mise/config.toml",
    ".config/mise/conf.d/x.toml",
    ".pre-commit-config.yaml",
    "sub/.pre-commit-config.yaml",
    "sub/.lefthook/x",
    "sub/Lefthook.yml",
    ".IDEA/x",
    ".Zed/tasks.json",
    ".Devcontainer/x",
  ])("asks for %s", async (path) => {
    const check = await checkEditTarget(path, bed.cwd, [bed.agentDir, bed.papHome]);
    expect(check).toEqual({
      auto: false,
      review: { why: "protected path", target: join(bed.cwd, path) },
    });
  });

  it("asks for a protected name below a decomposed (NFD) parent", async () => {
    const check = await checkEditTarget("e\u0301/.zed/tasks.json", bed.cwd, [bed.papHome]);
    expect(check).toMatchObject({ auto: false, review: { why: "protected path" } });
  });

  it("leaves a similar but different name automatic", async () => {
    for (const path of [
      "ideas/x",
      "mise.toml.md",
      "lefthook.txt",
      "lefthook.yaml.md",
      "mise.a.b.toml",
      "src/zed/tasks.json",
      "mise/other.toml",
      "config/mise/config2.toml",
      "pre-commit-config.yaml",
    ])
      expect((await checkEditTarget(path, bed.cwd, [bed.agentDir, bed.papHome])).auto).toBe(true);
  });
});
