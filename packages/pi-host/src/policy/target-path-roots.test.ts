import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { checkEditTarget } from "./target-path.ts";

// The Pi agent directory and pap's data directory are both protected roots: the worker passes both.
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

const tooBroad = "session directory too broad for automatic edits";

describe("checkEditTarget: several protected roots", () => {
  it("asks for a write into each root, wherever it sits", async () => {
    const roots = [bed.agentDir, bed.papHome];
    for (const root of roots) {
      expect(await checkEditTarget(join(root, "state.db"), bed.cwd, roots)).toEqual({
        auto: false,
        review: { why: "protected path", target: join(root, "state.db") },
      });
    }
    expect((await checkEditTarget("src/a.ts", bed.cwd, roots)).auto).toBe(true);
  });

  it("protects a root that sits inside the session directory, and then allows no automatic edit there", async () => {
    const data = join(bed.cwd, "data");
    const roots = [bed.agentDir, data];
    expect(await checkEditTarget("data/secrets/key", bed.cwd, roots)).toEqual({
      auto: false,
      review: { why: "protected path", target: join(data, "secrets", "key") },
    });
    expect(await checkEditTarget("src/a.ts", bed.cwd, roots)).toEqual({
      auto: false,
      review: { why: tooBroad, target: join(bed.cwd, "src", "a.ts") },
    });
  });

  it("protects a root that does not exist yet", async () => {
    const missing = join(bed.cwd, "not", "yet");
    expect((await checkEditTarget("not/yet/state.db", bed.cwd, [bed.agentDir, missing])).auto).toBe(false);
  });

  it("protects a root that is spelled through a symlink", async () => {
    await mkdir(join(bed.base, "real-pap"), { recursive: true });
    const link = join(bed.base, "pap-link");
    await symlink(join(bed.base, "real-pap"), link, "dir");
    const roots = [bed.agentDir, link];
    expect((await checkEditTarget(join(bed.base, "real-pap", "x"), bed.cwd, roots)).auto).toBe(false);
    expect((await checkEditTarget(join(link, "x"), bed.cwd, roots)).auto).toBe(false);
  });

  it("gives a session directory that contains the data directory no automatic edits", async () => {
    expect((await checkEditTarget("proj/src/a.ts", bed.base, [bed.papHome])).auto).toBe(false);
  });
});
