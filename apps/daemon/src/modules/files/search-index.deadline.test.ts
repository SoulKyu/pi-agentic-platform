import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { createSearchIndex, INDEX_LIMITS } from "./search-index.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

// A mount that never answers: the walk's opendir waits on this gate until the test opens it.
const hung = vi.hoisted(() => ({ wait: null as Promise<void> | null, calls: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    opendir: (async (...args: Parameters<typeof actual.opendir>) => {
      hung.calls += 1;
      if (hung.wait) await hung.wait;
      return actual.opendir(...args);
    }) as typeof actual.opendir,
  };
});

let bed: FilesBed;
let open: () => void;
beforeEach(() => {
  bed = createFilesBed();
  hung.calls = 0;
  hung.wait = new Promise<void>((resolve) => {
    open = resolve;
  });
});
afterEach(() => {
  open();
  hung.wait = null;
  bed.dispose();
});

const failing: GitRunner = { run: () => Promise.reject(new GitError("failed")) };

describe("the walk outside git has a deadline (I3, R2)", () => {
  it("answers what it has at the deadline with truncated, and leaves no timer behind", async () => {
    const root = join(bed.bb.base, "plain");
    bed.file(join(root, "a.ts"));
    const idx = createSearchIndex({ git: failing, deny: bed.deny, clock: bed.clock, logger: bed.logger });
    const pending = idx.paths("u1", bed.scope([root]), root);
    await vi.waitFor(() => expect(hung.calls).toBe(1), { timeout: 5000 });
    await bed.clock.advance(INDEX_LIMITS.walkDeadlineMs);
    expect(await pending).toEqual({ paths: [], truncated: true });
    expect(bed.clock.pending()).toBe(0);
  });

  it("clears its timer when the walk is quick", async () => {
    hung.wait = null;
    const root = join(bed.bb.base, "plain");
    bed.file(join(root, "a.ts"));
    const idx = createSearchIndex({ git: failing, deny: bed.deny, clock: bed.clock, logger: bed.logger });
    expect(await idx.paths("u1", bed.scope([root]), root)).toEqual({ paths: ["a.ts"], truncated: false });
    expect(bed.clock.pending()).toBe(0);
  });

  it("joins the walk still running after the TTL: no second walk, then a new one once it ended", async () => {
    const root = join(bed.bb.base, "plain");
    bed.file(join(root, "a.ts"));
    const idx = createSearchIndex({ git: failing, deny: bed.deny, clock: bed.clock, logger: bed.logger });
    const first = idx.paths("u1", bed.scope([root]), root);
    await vi.waitFor(() => expect(hung.calls).toBe(1), { timeout: 5000 });
    await bed.clock.advance(INDEX_LIMITS.walkDeadlineMs);
    await first;
    expect(hung.calls).toBe(1);
    await bed.clock.advance(INDEX_LIMITS.ttlMs + 1);
    expect(await idx.paths("u1", bed.scope([root]), root)).toEqual({ paths: [], truncated: true });
    expect(hung.calls).toBe(1);
    // The walk ends; the TTL counts from there, so the next search after it walks again.
    hung.wait = null;
    open();
    // Each round moves the clock past the TTL; once the late walk has ended, the next search walks again.
    await vi.waitFor(
      async () => {
        await bed.clock.advance(INDEX_LIMITS.ttlMs + 1);
        expect((await idx.paths("u1", bed.scope([root]), root)).paths).toEqual(["a.ts"]);
      },
      { timeout: 5000 },
    );
  });
});
