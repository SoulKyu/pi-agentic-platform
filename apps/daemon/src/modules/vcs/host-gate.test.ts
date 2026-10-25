import { methods } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { readBoxDiff } from "./box-status.ts";
import { createVcsService } from "./service.ts";
import { createVcsBed, fakeGit, type VcsBed } from "./testing/vcs-bed.ts";

/** Every call into the host file system is counted: a refused member root, and a box diff, make none. */
const fsCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const counted = Object.fromEntries(
    Object.entries(real).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            fsCalls.count++;
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  );
  return { ...counted, default: counted };
});

let bed: VcsBed;
beforeEach(() => {
  bed = createVcsBed();
});
afterEach(() => bed.dispose());

const ROOT = "/boxes/p1/project";
const boxes = createFakeProjectBoxSource({
  p1: {
    ownerId: "m1",
    root: ROOT,
    resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
    hosts: [],
    deleting: false,
  },
});
const member = testCaller({ userId: "m1" });

describe("Changes for a member (M14)", () => {
  it("a host root is forbidden with no git and no host fs call", async () => {
    const { git, calls } = fakeGit(() => "");
    const service = createVcsService({
      isMember: (id) => id === "m1",
      // The host folder is even among the member's roots: the gate does not rely on it being empty.
      roots: () => [bed.repo],
      boundary: bed.bb.config(),
      deny: bed.deny,
      git,
      hub: {
        registerSnapshot: () => undefined,
        publish: () => undefined,
        hasSubscribers: () => false,
      },
      clock: bed.clock,
      logger: bed.logger,
      boxes: () => boxes,
    });
    fsCalls.count = 0;
    for (const run of [
      () => service.prepareSubscription(member, bed.repo),
      () => service.refresh(member, bed.repo),
      () =>
        service.fileDiff(member, {
          root: bed.repo,
          path: "a.txt",
          from: { kind: "head" },
          to: { kind: "worktree" },
        }),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(calls).toHaveLength(0);
    expect(fsCalls.count).toBe(0);
    service.shutdown();
  });
});

describe("vcs.fileDiff paths under a gated box root (M14)", () => {
  const params = methods["vcs.fileDiff"].params;
  const base = { root: ROOT, from: { kind: "head" }, to: { kind: "worktree" } };

  it("refuses a path that climbs out of the repository, before any handler", () => {
    for (const path of ["../x", "a/../../x", "a/..", "/etc/passwd", "./a", "a//b"]) {
      expect(params.safeParse({ ...base, path }).success, path).toBe(false);
      expect(params.safeParse({ ...base, path: "ok", oldPath: path }).success, path).toBe(false);
    }
  });

  it("joins every accepted path below the root, and the host's file system is never asked about a link", async () => {
    const seen: string[] = [];
    const ops = {
      call: vi.fn(async (_projectId: string, op: { name: string; path?: string }) => {
        if (op.path !== undefined) seen.push(op.path);
        if (op.name === "fs.read")
          return { meta: { binary: false, size: 1 }, text: "t", offset: 0, nextOffset: null };
        return { text: "t", binary: false, truncated: false };
      }),
    };
    fsCalls.count = 0;
    // `link` may be a symlink in the guest: the host only spells the path, the guest owns the resolution.
    for (const path of ["link/passwd", "a/b/c.ts", "...", "a/.hidden", "weird name"]) {
      await readBoxDiff(
        { ops: ops as never, logger: silentLogger },
        "session",
        { projectId: "p1", root: ROOT },
        { path, from: { kind: "worktree" }, to: { kind: "worktree" } },
      );
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const path of seen) expect(path.startsWith(`${ROOT}/`), path).toBe(true);
    expect(fsCalls.count).toBe(0);
  });
});
