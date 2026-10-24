import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createBundleSkew, treeBundleOf } from "./bundle-skew.ts";

function make(
  installed: string,
  tree: string | (() => string),
  treeBundle: string | null = "/tree/dist-agent",
) {
  const log = captureLogger();
  const treeDigest = vi.fn(async () => (typeof tree === "string" ? tree : tree()));
  const installedDigest = vi.fn(async () => installed);
  const skew = createBundleSkew({ treeBundle, installedDigest, treeDigest, logger: log.logger });
  return { skew, log, treeDigest, installedDigest };
}
const named = (lines: Array<Record<string, unknown>>, msg: string) =>
  lines.filter((line) => line.msg === msg);

describe("createBundleSkew", () => {
  it("says ok when the digests are equal", async () => {
    const { skew, log } = make("aa", "aa");
    expect(await skew.check({ kind: "agent", id: "a1-0001" })).toBe("ok");
    expect(named(log.lines, "vm_bundle_stale")).toHaveLength(0);
  });

  it("says stale when they differ, and logs it once per agent", async () => {
    const { skew, log } = make("aa", "bb");
    expect(await skew.check({ kind: "agent", id: "a1-0001" })).toBe("stale");
    expect(await skew.check({ kind: "agent", id: "a1-0001" })).toBe("stale");
    expect(await skew.check({ kind: "agent", id: "a2-0001" })).toBe("stale");
    expect(named(log.lines, "vm_bundle_stale").map((line) => line.box)).toEqual([
      "agent:a1-0001",
      "agent:a2-0001",
    ]);
  });

  it("says ok when a fresh read of the installed digest now matches", async () => {
    const log = captureLogger();
    const reads: Array<boolean | undefined> = [];
    const skew = createBundleSkew({
      treeBundle: "/t",
      installedDigest: async (fresh) => (reads.push(fresh), fresh ? "bb" : "aa"),
      treeDigest: async () => "bb",
      logger: log.logger,
    });
    expect(await skew.check({ kind: "agent", id: "a1-0001" })).toBe("ok");
    expect(reads).toEqual([undefined, true]);
  });

  it("a tree digest that throws is unchecked, not cached: the next check reads again", async () => {
    const log = captureLogger();
    let calls = 0;
    const skew = createBundleSkew({
      treeBundle: "/t",
      installedDigest: async () => "aa",
      treeDigest: async () => {
        calls += 1;
        if (calls === 1) throw new Error("dist-agent is being rebuilt");
        return "aa";
      },
      logger: log.logger,
    });
    expect(await skew.check({ kind: "agent", id: "a1-0001" })).toBe("unchecked");
    expect(await skew.check({ kind: "agent", id: "a1-0001" })).toBe("ok");
    expect(calls).toBe(2);
  });

  it("is unchecked without a bundle of its own, with one info log", async () => {
    const { skew, log, installedDigest } = make("aa", "aa", null);
    expect(await skew.check({ kind: "agent", id: "a1-0001" })).toBe("unchecked");
    expect(await skew.check({ kind: "agent", id: "a2-0001" })).toBe("unchecked");
    expect(named(log.lines, "vm_bundle_unchecked")).toHaveLength(1);
    expect(installedDigest).not.toHaveBeenCalled();
  });

  it("keeps the boot digest", async () => {
    let built = "aa";
    const { skew, treeDigest } = make("aa", () => built);
    expect(await skew.check({ kind: "agent", id: "a1-0001" })).toBe("ok");
    built = "cc";
    expect(await skew.check({ kind: "agent", id: "a1-0001" })).toBe("ok");
    expect(treeDigest).toHaveBeenCalledTimes(1);
  });
});

describe("treeBundleOf", () => {
  it("finds dist-agent above the daemon, or null", () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-skew-"));
    const deep = join(root, "apps/daemon/dist");
    mkdirSync(deep, { recursive: true });
    expect(treeBundleOf(deep)).toBeNull();
    mkdirSync(join(root, "packages/pi-host/dist-agent"), { recursive: true });
    expect(treeBundleOf(deep)).toBe(join(root, "packages/pi-host/dist-agent"));
  });
});
