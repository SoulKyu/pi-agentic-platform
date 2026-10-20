import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createKataImages, type KataImages } from "./kata-images.ts";
import { runProfileJob } from "./profile-job.ts";
import { createFakeVmd, type FakeVmd } from "./testing/fake-vmd.ts";

/*
 * Mutants (RT-43), run for real in the final-fix report: "prune never called" (the first case), "keep without the running
 * tag" (the running case), "keep without the held tags of agents not seen yet" (the restart case), "prune error thrown into
 * the launch" (the failure case), "weekly tick without prune" (the weekly case).
 */
const NODE = `docker.io/library/node@sha256:${"9".repeat(64)}`;
let root: string;
let clock: FakeClock;
let fake: FakeVmd;
let held: Array<{ agentId: string; image: string }>;
const warn = vi.fn();
const logger = { ...silentLogger, warn };

const make = (): KataImages => createKataImages(configOf());
const keeps = () => fake.of("image.prune").map((p) => [...p.keep].sort());
const tagOf = (layer: string) => fake.of("image.build").find((b) => b.layer === layer)?.tag as string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-final-prune-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "bundle"), { recursive: true });
  writeFileSync(join(root, "bundle", "package.json"), "{}");
  writeFileSync(join(root, "agent", "settings.json"), "{}");
  clock = createFakeClock(Date.UTC(2026, 9, 20));
  fake = createFakeVmd();
  held = [];
  warn.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("image.prune after a build (final review I2)", () => {
  // Mutant: prune never called.
  it("keeps exactly the base, the newest profile and the agent's newest image", async () => {
    const tag = await make().resolve("scout-0001", ["git"], "thread");
    expect(keeps()).toEqual([[tagOf("base"), tagOf("profile"), tag].sort()]);
    expect(tag).toBe(tagOf("agent"));
  });

  it("calls nothing when no build ran", async () => {
    const images = make();
    await images.resolve("scout-0001", ["git"], "thread");
    fake.requests.length = 0;
    await images.resolve("scout-0001", ["git"], "thread");
    expect(fake.of("image.prune")).toEqual([]);
  });

  // Mutant: keep without the running tag.
  it("keeps the image a running VM uses while the agent's newer one builds behind it", async () => {
    const images = make();
    const old = await images.resolve("scout-0001", [], "thread");
    images.started("scout-0001", old);
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    await clock.advance(31_000);
    await expect(images.resolve("scout-0001", [], "isolated")).resolves.toBe(old);
    // The build behind queues first in the exclusive chain; this start answers after it.
    const next = await images.resolve("b-0002", [], "thread");
    expect(next).not.toBe(old);
    const last = keeps().at(-1) as string[];
    expect(last.sort()).toEqual([old, next, tagOf("base")].sort());
  });

  it("drops an agent's older image once a newer one is its latest and no VM runs on it", async () => {
    const images = make();
    const old = await images.resolve("scout-0001", [], "isolated");
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    await clock.advance(31_000);
    const next = await images.resolve("scout-0001", [], "isolated");
    expect(next).not.toBe(old);
    const last = keeps().at(-1) as string[];
    expect(last).not.toContain(old);
    expect(last).toContain(next);
  });

  // Mutant: keep without the held tags of agents not seen since the restart.
  it("keeps the recorded images of agents that have not started since this boot", async () => {
    held = [{ agentId: "sleeper-0003", image: "pap-agent-sleeper" }];
    await make().resolve("scout-0001", [], "thread");
    expect(keeps()[0]).toContain("pap-agent-sleeper");
  });

  // Mutant: the prune error thrown into the launch.
  it("logs a failed prune and still answers the tag", async () => {
    fake.failNext("image.prune", "unavailable");
    const tag = await make().resolve("scout-0001", [], "thread");
    expect(tag).toBe(tagOf("profile"));
    expect(warn).toHaveBeenCalledWith("agent_image_prune_failed", expect.anything());
  });

  it("skips the prune, logged, when the keep set is over the contract's 256", async () => {
    held = Array.from({ length: 300 }, (_, i) => ({ agentId: `a-${i}`, image: `pap-agent-${i}` }));
    await expect(make().resolve("scout-0001", [], "thread")).resolves.toBeDefined();
    expect(fake.of("image.prune")).toEqual([]);
    expect(warn).toHaveBeenCalledWith("agent_image_prune_skipped", expect.anything());
  });

  // Mutant: the weekly tick without prune.
  it("prunes after the weekly base rebuild too", async () => {
    const images = make();
    await images.resolve("scout-0001", [], "thread");
    fake.requests.length = 0;
    clock = createFakeClock(clock.now() + 8 * 86_400_000);
    const next = createKataImages(configOf());
    await next.upgradeBaseIfDue();
    expect(fake.ops()).toEqual(["image.build", "image.prune"]);
    expect(keeps()[0]).toContain(tagOf("base"));
  });
});

function configOf(): Parameters<typeof createKataImages>[0] {
  return {
    client: fake,
    clock,
    logger,
    papHome: join(root, "pap"),
    agentDir: join(root, "agent"),
    bundleRoot: join(root, "bundle"),
    nodeImage: NODE,
    weekFile: join(root, "pap", "vm", "base-week"),
    secrets: () => [],
    entries: { record: vi.fn(), forget: vi.fn(), held: () => held },
    profileRunner: (job) => Promise.resolve(runProfileJob(job)),
    notice: () => {},
  };
}
