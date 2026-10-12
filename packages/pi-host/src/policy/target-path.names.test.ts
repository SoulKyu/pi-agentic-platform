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
    ".lefthook.yml",
    "lefthook-local.yml",
    ".lefthook-local.yml",
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
    for (const path of ["ideas/x", "mise.toml.md", "lefthook.yaml", "src/zed/tasks.json"])
      expect((await checkEditTarget(path, bed.cwd, [bed.agentDir, bed.papHome])).auto).toBe(true);
  });
});
