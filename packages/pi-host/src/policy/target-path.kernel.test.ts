import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { kernelResolve } from "./kernel-path.ts";
import { checkReadTarget } from "./read-target.ts";
import { checkEditTarget, realTarget } from "./target-path.ts";

// Pi collapses `..` before it opens a file (probed by the host tests); the kernel follows a symlink first. The
// policy asks when either reading reaches something protected or outside.
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
  await mkdir(join(bed.base, "home"), { recursive: true });
  await mkdir(join(bed.outside, "deep", "deeper"), { recursive: true });
  await mkdir(join(bed.papHome, "secrets"), { recursive: true });
  await mkdir(join(bed.cwd, ".git", "info"), { recursive: true });
  await writeFile(join(bed.papHome, "secrets", "device.key"), "k");
  await writeFile(join(bed.papHome, "state.db"), "d");
  await symlink(join(bed.outside, "deep"), join(bed.cwd, "out"), "dir");
  await symlink(join(bed.outside, "deep", "deeper"), join(bed.cwd, "out2"), "dir");
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
    await expect(kernelResolve(bed.cwd, "a/".repeat(2100))).rejects.toThrow(RangeError);
  });

  it("follows the last link, keeps what does not exist as spelled, and stops on a loop", async () => {
    expect(await kernelResolve(bed.cwd, "out")).toBe(join(bed.outside, "deep"));
    expect(await kernelResolve(bed.cwd, "out/new/../file")).toBe(join(bed.outside, "deep", "file"));
    await symlink(join(bed.cwd, "loop"), join(bed.cwd, "loop"));
    await expect(kernelResolve(bed.cwd, "loop/x")).rejects.toThrow("too many symbolic links");
  });
});

// R88b: the card names the file Pi acts on (Pi collapses `..` first); the kernel's file is a second line.
const piFile = (path: string) => realTarget(resolve(bed.cwd, path));

describe("a symlink followed by .. (reads)", () => {
  it("asks for a read through /proc/self/root/.. and through a link into secrets/, naming Pi's file first", async () => {
    const key = join(bed.papHome, "secrets", "device.key");
    const proc = viaProcRoot(key);
    expect(await checkReadTarget("read", { path: proc }, dirs())).toEqual({
      why: "protected path",
      target: await piFile(proc),
      kernelTarget: key,
      targetLabel: "the file Pi reads",
      kernelLabel: "protected path, if a tool follows the symlink before ..",
    });
    for (const path of ["s/../state.db", `${bed.cwd}/s/../state.db`])
      expect(await checkReadTarget("read", { path }, dirs())).toEqual({
        why: "protected path",
        target: await piFile(path),
        kernelTarget: join(bed.papHome, "state.db"),
        targetLabel: "the file Pi reads",
        kernelLabel: "protected path, if a tool follows the symlink before ..",
      });
    expect(await piFile("s/../state.db")).toBe(join(bed.cwd, "state.db"));
  });

  it("names pap's own file first when Pi's reading is the protected one and the kernel's is elsewhere", async () => {
    expect(await checkReadTarget("read", { path: "out2/../../pap/state.db" }, dirs())).toEqual({
      why: "protected path",
      target: join(bed.papHome, "state.db"),
      kernelTarget: undefined,
    });
  });

  it("gives each line the reason of its own file when both readings are protected", async () => {
    await mkdir(join(bed.papHome, "backups", "deep"), { recursive: true });
    await symlink(join(bed.papHome, "backups", "deep"), join(bed.papHome, "lnk"), "dir");
    expect(await checkReadTarget("read", { path: `${bed.papHome}/lnk/../secrets/k` }, dirs())).toEqual({
      why: "protected path",
      target: join(bed.papHome, "secrets", "k"),
      kernelTarget: join(bed.papHome, "backups", "secrets", "k"),
      targetLabel: "protected path",
      kernelLabel: "protected path, if a tool follows the symlink before ..",
    });
  });

  it("asks through /proc/self/cwd/.. as well", async () => {
    const rel = relative(join(process.cwd(), ".."), join(bed.papHome, "state.db"));
    expect(await checkReadTarget("read", { path: `/proc/self/cwd/../${rel}` }, dirs())).toMatchObject({
      why: "protected path",
    });
  });

  it("asks for a search rooted above pap's home through /proc/self/root/..", async () => {
    for (const tool of ["grep", "find"])
      expect(await checkReadTarget(tool, { pattern: "x", path: viaProcRoot(bed.base) }, dirs())).toEqual({
        why: "searches pap's data directory",
        target: await piFile(viaProcRoot(bed.base)),
        kernelTarget: bed.base,
        targetLabel: "the file Pi reads",
        kernelLabel: "searches pap's data directory, if a tool follows the symlink before ..",
      });
    expect(await checkReadTarget("ls", { path: viaProcRoot(bed.base) }, dirs())).toBeUndefined();
  });

  it("leaves a harmless link-then-.. read alone", async () => {
    await writeFile(join(bed.cwd, "src", "a.ts"), "x");
    expect(await checkReadTarget("read", { path: "in/../src/a.ts" }, dirs())).toBeUndefined();
  });

  it("asks, without walking, for a spelling longer than the kernel accepts", async () => {
    expect(await checkReadTarget("read", { path: `src/${"a/".repeat(2100)}x` }, dirs())).toEqual({
      why: "protected path",
    });
  });
});

describe("a symlink followed by .. (writes)", () => {
  it("names the file Pi writes first and the kernel's file second", async () => {
    for (const path of [`${bed.cwd}/out/../x`, "out/../x"])
      expect(await checkEditTarget(path, bed.cwd, roots())).toEqual({
        auto: false,
        review: {
          why: "outside the session directory",
          target: join(bed.cwd, "x"),
          kernelTarget: join(bed.outside, "x"),
          targetLabel: "the file Pi writes",
          kernelLabel: "outside the session directory, if a tool follows the symlink before ..",
        },
      });
  });

  it("names pap's database, not another file, when Pi's reading is the protected one", async () => {
    const check = await checkEditTarget("out2/../../pap/state.db", bed.cwd, roots());
    expect(check).toEqual({
      auto: false,
      review: {
        why: "protected path",
        target: join(bed.papHome, "state.db"),
        kernelTarget: join(bed.outside, "pap", "state.db"),
        targetLabel: "protected path",
        kernelLabel: "outside the session directory, if a tool follows the symlink before ..",
      },
    });
  });

  it("names the home file Pi writes for out2/../../.bashrc, with the kernel's file second", async () => {
    const check = await checkEditTarget("out2/../../.bashrc", bed.cwd, roots());
    expect(check).toEqual({
      auto: false,
      review: {
        why: "outside the session directory",
        target: join(bed.base, ".bashrc"),
        kernelTarget: join(bed.outside, ".bashrc"),
        targetLabel: "outside the session directory",
        kernelLabel: "outside the session directory, if a tool follows the symlink before ..",
      },
    });
  });

  it("asks for /proc/self/root/.. into the home directory, naming Pi's file first", async () => {
    const kernel = join(bed.base, "home", ".bashrc");
    const check = await checkEditTarget(viaProcRoot(kernel), bed.cwd, roots());
    expect(check).toEqual({
      auto: false,
      review: {
        why: "outside the session directory",
        target: await piFile(viaProcRoot(kernel)),
        kernelTarget: kernel,
        targetLabel: "outside the session directory",
        kernelLabel: "outside the session directory, if a tool follows the symlink before ..",
      },
    });
  });

  it("asks when only the kernel reading reaches a protected name or root", async () => {
    expect(await checkEditTarget("g/../hooks/pre-commit", bed.cwd, roots())).toEqual({
      auto: false,
      review: {
        why: "protected path",
        target: join(bed.cwd, "hooks", "pre-commit"),
        kernelTarget: join(bed.cwd, ".git", "hooks", "pre-commit"),
        targetLabel: "the file Pi writes",
        kernelLabel: "protected path, if a tool follows the symlink before ..",
      },
    });
    expect(await checkEditTarget("s/../state.db", bed.cwd, roots())).toEqual({
      auto: false,
      review: {
        why: "protected path",
        target: join(bed.cwd, "state.db"),
        kernelTarget: join(bed.papHome, "state.db"),
        targetLabel: "the file Pi writes",
        kernelLabel: "protected path, if a tool follows the symlink before ..",
      },
    });
  });

  it("leaves a link inside the folder followed by .. automatic", async () => {
    expect(await checkEditTarget("in/../x.ts", bed.cwd, roots())).toEqual({ auto: true });
    expect(await checkEditTarget(`${bed.cwd}/in/../x.ts`, bed.cwd, roots())).toEqual({ auto: true });
  });

  it("asks, without walking, for a spelling longer than the kernel accepts", async () => {
    expect(await checkEditTarget(`src/${"a/".repeat(2100)}x`, bed.cwd, roots())).toEqual({
      auto: false,
      review: { why: "outside the session directory" },
    });
  });
});
