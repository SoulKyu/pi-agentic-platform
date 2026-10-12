import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { kernelResolve } from "./kernel-path.ts";
import { checkReadTarget } from "./read-target.ts";
import { checkEditTarget } from "./target-path.ts";

// Pi collapses `..` before it opens a file (probed by the host tests); the kernel follows a symlink first. The
// policy asks when either reading reaches something protected or outside.
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
  await mkdir(join(bed.base, "home"), { recursive: true });
  await mkdir(join(bed.outside, "deep"), { recursive: true });
  await mkdir(join(bed.papHome, "secrets"), { recursive: true });
  await mkdir(join(bed.cwd, ".git", "info"), { recursive: true });
  await writeFile(join(bed.papHome, "secrets", "device.key"), "k");
  await writeFile(join(bed.papHome, "state.db"), "d");
  await symlink(join(bed.outside, "deep"), join(bed.cwd, "out"), "dir");
  await symlink(join(bed.papHome, "secrets"), join(bed.cwd, "s"), "dir");
  await symlink(join(bed.cwd, "src"), join(bed.cwd, "in"), "dir");
  await symlink(join(bed.cwd, ".git", "info"), join(bed.cwd, "g"), "dir");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

const dirs = () => ({ cwd: bed.cwd, papHome: bed.papHome, agentDir: bed.agentDir });
const viaProcRoot = (path: string) => `/proc/self/root/..${path}`;
const roots = () => [bed.agentDir, bed.papHome];

describe("kernelResolve", () => {
  it("applies .. to the real directory reached through a symlink", async () => {
    expect(await kernelResolve(bed.cwd, "out/../x")).toBe(join(bed.outside, "x"));
    expect(await kernelResolve(bed.cwd, `${bed.cwd}/s/../state.db`)).toBe(join(bed.papHome, "state.db"));
    expect(await kernelResolve(bed.cwd, viaProcRoot(join(bed.base, "pap")))).toBe(bed.papHome);
  });

  it("follows the last link, keeps what does not exist as spelled, and stops on a loop", async () => {
    expect(await kernelResolve(bed.cwd, "out")).toBe(join(bed.outside, "deep"));
    expect(await kernelResolve(bed.cwd, "out/new/../file")).toBe(join(bed.outside, "deep", "file"));
    await symlink(join(bed.cwd, "loop"), join(bed.cwd, "loop"));
    await expect(kernelResolve(bed.cwd, "loop/x")).rejects.toThrow("too many symbolic links");
  });
});

describe("a symlink followed by .. (reads)", () => {
  it("asks for a read through /proc/self/root/.. and through a link into secrets/", async () => {
    const key = join(bed.papHome, "secrets", "device.key");
    expect(await checkReadTarget("read", { path: viaProcRoot(key) }, dirs())).toEqual({
      why: "protected path",
      target: key,
    });
    expect(await checkReadTarget("read", { path: "s/../state.db" }, dirs())).toEqual({
      why: "protected path",
      target: join(bed.papHome, "state.db"),
    });
    expect(await checkReadTarget("read", { path: `${bed.cwd}/s/../state.db` }, dirs())).toEqual({
      why: "protected path",
      target: join(bed.papHome, "state.db"),
    });
  });

  it("asks through /proc/self/cwd/.. as well", async () => {
    const parent = join(process.cwd(), "..");
    const rel = (await import("node:path")).relative(parent, join(bed.papHome, "state.db"));
    expect(await checkReadTarget("read", { path: `/proc/self/cwd/../${rel}` }, dirs())).toMatchObject({
      why: "protected path",
      target: join(bed.papHome, "state.db"),
    });
  });

  it("asks for a search rooted above pap's home through /proc/self/root/..", async () => {
    for (const tool of ["grep", "find"])
      expect(await checkReadTarget(tool, { pattern: "x", path: viaProcRoot(bed.base) }, dirs())).toEqual({
        why: "searches pap's data directory",
        target: bed.base,
      });
    expect(await checkReadTarget("ls", { path: viaProcRoot(bed.base) }, dirs())).toBeUndefined();
  });

  it("leaves a harmless link-then-.. read alone", async () => {
    await writeFile(join(bed.cwd, "src", "a.ts"), "x");
    expect(await checkReadTarget("read", { path: "in/../src/a.ts" }, dirs())).toBeUndefined();
  });
});

describe("a symlink followed by .. (writes)", () => {
  it("judges an absolute path through a link out of the folder as outside, naming the file", async () => {
    expect(await checkEditTarget(`${bed.cwd}/out/../x`, bed.cwd, roots())).toEqual({
      auto: false,
      review: { why: "outside the session directory", target: join(bed.outside, "x") },
    });
    expect(await checkEditTarget("out/../x", bed.cwd, roots())).toEqual({
      auto: false,
      review: { why: "outside the session directory", target: join(bed.outside, "x") },
    });
  });

  it("names the right file for /proc/self/root/.. into the home directory", async () => {
    const target = join(bed.base, "home", ".bashrc");
    expect(await checkEditTarget(viaProcRoot(target), bed.cwd, roots())).toEqual({
      auto: false,
      review: { why: "outside the session directory", target },
    });
  });

  it("asks when only the kernel reading reaches a protected name or root", async () => {
    expect(await checkEditTarget("g/../hooks/pre-commit", bed.cwd, roots())).toEqual({
      auto: false,
      review: { why: "protected path", target: join(bed.cwd, ".git", "hooks", "pre-commit") },
    });
    expect(await checkEditTarget("s/../state.db", bed.cwd, roots())).toEqual({
      auto: false,
      review: { why: "protected path", target: join(bed.papHome, "state.db") },
    });
  });

  it("leaves a link inside the folder followed by .. automatic", async () => {
    expect(await checkEditTarget("in/../x.ts", bed.cwd, roots())).toEqual({ auto: true });
    expect(await checkEditTarget(`${bed.cwd}/in/../x.ts`, bed.cwd, roots())).toEqual({
      auto: true,
    });
  });
});
