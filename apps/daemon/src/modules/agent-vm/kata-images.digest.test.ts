import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { type DigestRunner, threadDigestRunner } from "./digest-runner.ts";
import { treeDigest } from "./image-inputs.ts";
import { createKataImages } from "./kata-images.ts";
import { runProfileJob } from "./profile-job.ts";
import { createFakeVmd, type FakeVmd } from "./testing/fake-vmd.ts";

/*
 * Mutants, run for real in the report: "digest in process" (the thread case), "claim after the digest" (the nothing-due case),
 * "no shared flight" (the concurrent case), "cache dropped" (the hour case), "claim kept on a failed digest" (the hand-back case).
 */
const NODE = `docker.io/library/node@sha256:${"9".repeat(64)}`;
const HOUR = 3_600_001;
let root: string;
let clock: FakeClock;
let fake: FakeVmd;
let runs: Array<{ dir: string; format: string }>;

const bundle = () => join(root, "bundle");
const weekFile = () => join(root, "pap", "vm", "base-week");

function make(digestRunner: DigestRunner, at: FakeClock = clock) {
  return createKataImages({
    client: fake,
    clock: at,
    logger: silentLogger,
    papHome: join(root, "pap"),
    agentDir: join(root, "agent"),
    bundleRoot: bundle(),
    nodeImage: NODE,
    weekFile: weekFile(),
    secrets: () => [],
    entries: { record: () => {}, forget: () => {}, held: () => [] },
    profileRunner: (job) => Promise.resolve(runProfileJob(job)),
    digestRunner,
    notice: () => {},
  });
}

const counting: DigestRunner = async (dir, format) => {
  runs.push({ dir, format });
  return treeDigest(dir, format);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-digest-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(bundle(), "sub"), { recursive: true });
  writeFileSync(join(bundle(), "package.json"), "{}");
  writeFileSync(join(bundle(), "sub", "a.js"), "export {}");
  writeFileSync(join(root, "agent", "settings.json"), "{}");
  clock = createFakeClock(Date.UTC(2026, 9, 20));
  fake = createFakeVmd();
  runs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("threadDigestRunner", () => {
  it("makes the same digest as the in-process run", async () => {
    expect(await threadDigestRunner(bundle(), "salt")).toBe(treeDigest(bundle(), "salt"));
  });

  it("rejects for a folder that is not there, and never hangs", async () => {
    await expect(threadDigestRunner(join(root, "missing"), "salt")).rejects.toBeInstanceOf(Error);
  });
});

describe("the bundle digest goes through the runner", () => {
  it("resolve and installedDigest share it, salted as the base tag is, and read it again after an hour", async () => {
    const images = make(counting);
    await images.resolve("scout-0001", [], "thread");
    expect(runs).toEqual([{ dir: bundle(), format: `pap-base-2\0${NODE}` }]);
    const digest = await images.installedDigest();
    expect(digest).toBe(treeDigest(bundle(), `pap-base-2\0${NODE}`));
    expect(runs).toHaveLength(1);
    await images.installedDigest(true);
    expect(runs).toHaveLength(2);
    await clock.advance(HOUR);
    await images.installedDigest();
    expect(runs).toHaveLength(3);
  });

  it("digestOf hashes another folder through the runner", async () => {
    await make(counting).digestOf(join(root, "agent"));
    expect(runs).toEqual([{ dir: join(root, "agent"), format: `pap-base-2\0${NODE}` }]);
  });

  it("two concurrent callers share one digest run, and a failure is not cached", async () => {
    let release: (digest: string) => void = () => {};
    let fail = true;
    const runner: DigestRunner = (dir, format) => {
      runs.push({ dir, format });
      return fail
        ? new Promise<string>((_, reject) => void (release = () => reject(new Error("boom"))))
        : Promise.resolve("d".repeat(64));
    };
    const images = make(runner);
    const both = Promise.allSettled([images.installedDigest(), images.installedDigest()]);
    await Promise.resolve();
    release("");
    const settled = await both;
    expect(runs).toHaveLength(1);
    expect(settled.map((one) => one.status)).toEqual(["rejected", "rejected"]);
    expect(settled[0]).toMatchObject({ reason: { code: "sandbox_unavailable" } });
    fail = false;
    await expect(images.installedDigest()).resolves.toBe("d".repeat(64));
    expect(runs).toHaveLength(2);
  });
});

describe("the hourly tick", () => {
  it("reads nothing and calls no vmd when nothing is due", async () => {
    await make(counting).resolve("scout-0001", [], "thread");
    runs.length = 0;
    fake.requests.length = 0;
    const later = make(counting);
    await clock.advance(HOUR);
    await later.upgradeBaseIfDue();
    expect(runs).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("builds the base it claimed when a week is due, after one digest", async () => {
    await make(counting).resolve("scout-0001", [], "thread");
    runs.length = 0;
    const next = make(counting, createFakeClock(clock.now() + 8 * 86_400_000));
    await next.upgradeBaseIfDue();
    expect(runs).toHaveLength(1);
    expect(fake.of("image.build").filter((b) => b.layer === "base")).toHaveLength(2);
  });

  it("hands the claim back when the digest fails, so the next tick builds", async () => {
    await make(counting).resolve("scout-0001", [], "thread");
    const later = createFakeClock(clock.now() + 8 * 86_400_000);
    let broken = true;
    const next = make(
      (dir, format) => (broken ? Promise.reject(new Error("io")) : counting(dir, format)),
      later,
    );
    await next.upgradeBaseIfDue();
    const builtBefore = fake.of("image.build").length;
    broken = false;
    await later.advance(HOUR);
    await next.upgradeBaseIfDue();
    expect(fake.of("image.build")).toHaveLength(builtBefore + 1);
  });
});
