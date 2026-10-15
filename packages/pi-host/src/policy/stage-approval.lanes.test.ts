import { link, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let lane: string;
beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
  await mkdir(join(bed.base, "home"), { recursive: true });
  lane = join(bed.papHome, "worktrees", "fix-a-1a2b");
  await mkdir(join(lane, "src"), { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

describe("stage 03 and a lane worktree (M9R44)", () => {
  it("lets an edit in the session's own lane run in auto-accept-edits", async () => {
    const h = bed.harness({ cwd: lane });
    expect(await h.run("edit", { path: "src/x.ts" })).toBeUndefined();
    expect(h.asks).toHaveLength(0);
  });

  it("asks for the same edit from pap's home outside a lane", async () => {
    await mkdir(join(bed.papHome, "src"), { recursive: true });
    const h = bed.harness({ cwd: join(bed.papHome, "src") });
    await h.run("edit", { path: "x.ts" });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.message).toContain(`→ ${join(bed.papHome, "src", "x.ts")} (protected path)`);
  });

  it("asks for the lane's .git file", async () => {
    const h = bed.harness({ cwd: lane });
    await h.run("edit", { path: ".git" });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.message).toContain(`→ ${join(lane, ".git")} (protected path)`);
  });

  it("asks for a lane file that is a hard link to pap's state", async () => {
    await writeFile(join(bed.papHome, "state.db"), "x");
    await link(join(bed.papHome, "state.db"), join(lane, "hl"));
    const h = bed.harness({ cwd: lane });
    await h.run("edit", { path: "hl" });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.message).toContain(`→ ${join(lane, "hl")} (protected path)`);
  });
});
