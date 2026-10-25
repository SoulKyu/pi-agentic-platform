import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_VM_PROTOCOL } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { BUILD_NOTICE, isoWeek } from "./image-policy.ts";
import { createKataImages, type KataImages } from "./kata-images.ts";
import { runProfileJob } from "./profile-job.ts";
import { PROFILE_SECRET_NOTICE } from "./secret-scan.ts";
import { createFakeVmd, type FakeVmd } from "./testing/fake-vmd.ts";

/*
 * Mutants (RT-43), run for real in the T15a report: "week not persisted" (the restart case rebuilds every image twice), "week
 * persisted after the flip" (the order case), "single flight dropped" (the concurrent case builds twice), "build waits for the
 * fallback" (the build-then-use case blocks), "notice every time" (the notice-once case), "record dropped" (the entries case),
 * "secret scan result swallowed" (the secret case), "profile cache dropped" / "never expires" (the cache cases).
 */
const NODE = `docker.io/library/node@sha256:${"9".repeat(64)}`;
let root: string;
let clock: FakeClock;
let fake: FakeVmd;
const notices: Array<[string, string]> = [];
const entries = { record: vi.fn(), forget: vi.fn(), held: () => [] };
let secretCalls = 0;
let secrets: string[] = [];

const paths = () => ({
  home: join(root, "pap"),
  agentDir: join(root, "agent"),
  bundle: join(root, "bundle"),
  weekFile: join(root, "pap", "vm", "base-week"),
});

function make(overrides: Partial<Parameters<typeof createKataImages>[0]> = {}): KataImages {
  const p = paths();
  return createKataImages({
    client: fake,
    clock,
    logger: silentLogger,
    papHome: p.home,
    agentDir: p.agentDir,
    bundleRoot: p.bundle,
    nodeImage: NODE,
    weekFile: p.weekFile,
    secrets: () => (secretCalls++, secrets),
    entries,
    profileRunner: (job) => Promise.resolve(runProfileJob(job)),
    notice: (agentId, text) => void notices.push([agentId, text]),
    ...overrides,
  });
}

const builds = () => fake.of("image.build");
const tagOf = (layer: string) => builds().find((b) => b.layer === layer)?.tag;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-t15-images-"));
  const p = paths();
  mkdirSync(p.agentDir, { recursive: true });
  mkdirSync(p.bundle, { recursive: true });
  writeFileSync(join(p.bundle, "package.json"), "{}");
  writeFileSync(join(p.agentDir, "settings.json"), "{}");
  clock = createFakeClock(Date.UTC(2026, 9, 20));
  fake = createFakeVmd();
  notices.length = 0;
  entries.record.mockClear();
  entries.forget.mockClear();
  secretCalls = 0;
  secrets = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolve: builds the layers the first start needs", () => {
  it("base, then profile, then agent, each from the one before, nothing else", async () => {
    const seen: Array<{ layer: string; context: boolean }> = [];
    fake.handle("image.build", (request) => {
      if (request.op !== "image.build") return {};
      seen.push({
        layer: request.layer,
        context: existsSync(join(paths().home, "vm", "build", "profile", "pi-agent", "settings.json")),
      });
      fake.images.add(request.tag);
      return { tag: request.tag };
    });
    const tag = await make().resolve("scout-0001", ["git", "curl"], "thread");
    const [base, profile, agent] = builds();
    expect(builds().map((b) => b.layer)).toEqual(["base", "profile", "agent"]);
    expect(base).toMatchObject({ from: NODE, upgrade: true, aptPackages: [] });
    expect(profile).toMatchObject({ from: base?.tag, upgrade: false, aptPackages: [] });
    expect(agent).toMatchObject({ from: profile?.tag, aptPackages: ["curl", "git"] });
    expect(tag).toBe(agent?.tag);
    // The profile tree was there when its build ran (pap-vmd copies it from $PAP_HOME/vm/build/profile).
    expect(seen.find((one) => one.layer === "profile")?.context).toBe(true);
    expect(fake.ops().some((op) => op.startsWith("disk.") || op.startsWith("vm."))).toBe(false);
  });

  it("an agent with no system package runs on the profile image", async () => {
    const tag = await make().resolve("scout-0001", [], "thread");
    expect(builds().map((b) => b.layer)).toEqual(["base", "profile"]);
    expect(tag).toBe(tagOf("profile"));
  });

  it("builds nothing when every layer exists, and answers the same tag", async () => {
    const images = make();
    const first = await images.resolve("scout-0001", ["git"], "thread");
    fake.requests.length = 0;
    await expect(images.resolve("scout-0001", ["git"], "thread")).resolves.toBe(first);
    expect(fake.ops()).toEqual(["image.list", "image.list"]);
  });

  it("records the profile build's pairs for the image the launch gets (AVM-E44, S1)", async () => {
    const tag = await make().resolve("scout-0001", ["git"], "thread");
    expect(entries.record).toHaveBeenCalledWith("scout-0001", tag, expect.any(Array));
  });

  it("two agents starting together share one build of each layer", async () => {
    const images = make();
    const [a, b] = await Promise.all([
      images.resolve("a-0001", ["git"], "thread"),
      images.resolve("b-0002", ["git"], "thread"),
    ]);
    expect(a).toBe(b);
    expect(builds().map((one) => one.layer)).toEqual(["base", "profile", "agent"]);
  });
});

describe("resolve: the policy decides", () => {
  it("keeps a running agent on its image while the new one builds, with the notice once", async () => {
    const images = make();
    const old = await images.resolve("scout-0001", [], "isolated");
    images.started("scout-0001", old);
    writeFileSync(join(paths().agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    await clock.advance(31_000);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    fake.handle("image.build", async (request) => {
      await held;
      if (request.op === "image.build") fake.images.add(request.tag);
      return {};
    });
    entries.record.mockClear();
    await expect(images.resolve("scout-0001", [], "isolated")).resolves.toBe(old);
    await expect(images.resolve("scout-0001", [], "isolated")).resolves.toBe(old);
    expect(notices).toEqual([["scout-0001", BUILD_NOTICE]]);
    // The build holds the profile's tree for minutes: a start later than the cache still answers, from the last profile.
    await clock.advance(31_000);
    await expect(images.resolve("scout-0001", [], "isolated")).resolves.toBe(old);
    // The agent still runs the old image: its pairs are not replaced by the new image's.
    expect(entries.record).not.toHaveBeenCalled();
    release();
    await expect.poll(() => fake.images.size).toBe(3);
    const next = await images.resolve("scout-0001", [], "isolated");
    expect(next).not.toBe(old);
    expect(entries.record).toHaveBeenCalledWith("scout-0001", next, expect.any(Array));
  });

  // M4: the VM of the agent's thread runs; a worker spawned into it needs no image, no preparation, no new pairs.
  it("answers a thread spawn the running image at once: no listing, no preparation, no pairs recorded", async () => {
    const images = make();
    const old = await images.resolve("scout-0001", [], "thread");
    images.started("scout-0001", old);
    writeFileSync(join(paths().agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    await clock.advance(31_000);
    fake.requests.length = 0;
    entries.record.mockClear();
    const prepared = secretCalls;
    await expect(images.resolve("scout-0001", [], "thread")).resolves.toBe(old);
    expect(fake.requests).toEqual([]);
    expect(secretCalls).toBe(prepared);
    expect(entries.record).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("refuses an agent whose running image speaks another protocol, and builds the new one", async () => {
    const images = make();
    const old = await images.resolve("scout-0001", [], "isolated");
    images.started("scout-0001", old, AGENT_VM_PROTOCOL + 1);
    writeFileSync(join(paths().agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    await clock.advance(31_000);
    await expect(images.resolve("scout-0001", [], "isolated")).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
    await expect.poll(() => fake.images.size).toBe(3);
    expect(notices).toHaveLength(1);
    await expect(images.resolve("scout-0001", [], "isolated")).resolves.not.toBe(old);
  });
});

describe("the profile", () => {
  it("is prepared once within 30 s and again after", async () => {
    const images = make();
    await images.resolve("a-0001", [], "thread");
    await images.resolve("b-0002", [], "thread");
    expect(secretCalls).toBe(1);
    await clock.advance(30_001);
    await images.resolve("c-0003", [], "thread");
    expect(secretCalls).toBe(2);
  });

  it("is refused with a notice when a file of it holds a known secret, and no profile build runs", async () => {
    mkdirSync(join(paths().agentDir, "skills", "x"), { recursive: true });
    writeFileSync(join(paths().agentDir, "skills", "x", "SKILL.md"), "key=sk-live-0123456789abcdef");
    secrets = ["sk-live-0123456789abcdef"];
    await expect(make().resolve("scout-0001", [], "thread")).rejects.toMatchObject({
      code: "config_invalid",
    });
    expect(notices).toEqual([["scout-0001", PROFILE_SECRET_NOTICE]]);
    expect(builds().map((b) => b.layer)).not.toContain("profile");
  });

  it("answers sandbox_unavailable, not a path, when the root-owned bundle is missing", async () => {
    rmSync(paths().bundle, { recursive: true });
    await expect(make().resolve("scout-0001", [], "thread")).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });
});

describe("the base image: the week is persisted before the new key is used (ledger 215)", () => {
  it("a restart finds the same tags and rebuilds nothing", async () => {
    const first = await make().resolve("scout-0001", ["git"], "thread");
    expect(readFileSync(paths().weekFile, "utf8").trim()).toBe(isoWeek(clock.now()));
    fake.requests.length = 0;
    await expect(make().resolve("scout-0001", ["git"], "thread")).resolves.toBe(first);
    expect(fake.of("image.build")).toEqual([]);
  });

  it("writes the week before the key it feeds goes live, and only after the build worked", async () => {
    const images = make();
    await images.resolve("scout-0001", [], "thread");
    const before = tagOf("profile");
    clock = createFakeClock(clock.now() + 8 * 86_400_000);
    const second = make({ clock });
    let weekAtBuild: string | null = null;
    fake.handle("image.build", (request) => {
      if (request.op !== "image.build") return {};
      if (request.layer === "base") weekAtBuild = readFileSync(paths().weekFile, "utf8").trim();
      fake.images.add(request.tag);
      return {};
    });
    await second.upgradeBaseIfDue();
    // The old week was on disk while the build ran; the new one after it, before any profile used the new key.
    expect(weekAtBuild).toBe(isoWeek(clock.now() - 8 * 86_400_000));
    expect(readFileSync(paths().weekFile, "utf8").trim()).toBe(isoWeek(clock.now()));
    const rebuilt = builds().filter((b) => b.layer === "base");
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[1]).toMatchObject({ upgrade: true, tag: rebuilt[0]?.tag });
    await second.resolve("scout-0001", [], "thread");
    expect(tagOf("profile")).toBeDefined();
    expect(builds().filter((b) => b.layer === "profile")).toHaveLength(2);
    expect(builds().filter((b) => b.layer === "profile")[1]?.tag).not.toBe(before);
    // A restart after the upgrade keeps the new key.
    fake.requests.length = 0;
    await make({ clock }).resolve("scout-0001", [], "thread");
    expect(fake.of("image.build")).toEqual([]);
  });

  it("does nothing twice in a week, and retries a failure after an hour (in memory: a new instance has no wait left)", async () => {
    const images = make();
    await images.resolve("scout-0001", [], "thread");
    clock = createFakeClock(clock.now() + 8 * 86_400_000);
    const next = make({ clock });
    fake.failNext("image.build", "failed");
    await next.upgradeBaseIfDue();
    const count = builds().length;
    await next.upgradeBaseIfDue();
    expect(builds()).toHaveLength(count);
    await clock.advance(3_600_001);
    await next.upgradeBaseIfDue();
    expect(builds()).toHaveLength(count + 1);
    await next.upgradeBaseIfDue();
    expect(builds()).toHaveLength(count + 1);
    // Failed again, then a restart: the new process has no retry timer and tries at once.
    clock = createFakeClock(clock.now() + 8 * 86_400_000);
    fake.failNext("image.build", "failed");
    await make({ clock }).upgradeBaseIfDue();
    const failed = builds().length;
    await make({ clock }).upgradeBaseIfDue();
    expect(builds()).toHaveLength(failed + 1);
  });

  it("does not count a week whose file could not be written", async () => {
    const images = make();
    await images.resolve("scout-0001", [], "thread");
    clock = createFakeClock(clock.now() + 8 * 86_400_000);
    mkdirSync(`${paths().weekFile}.tmp`);
    const next = make({ clock });
    await next.upgradeBaseIfDue();
    const count = builds().length;
    await next.upgradeBaseIfDue();
    expect(builds()).toHaveLength(count);
    // The new key is not live: the profile and agent images of the old key are still the ones a start finds.
    await next.resolve("scout-0001", [], "thread");
    expect(builds()).toHaveLength(count);
    rmSync(`${paths().weekFile}.tmp`, { recursive: true });
    await clock.advance(3_600_001);
    await next.upgradeBaseIfDue();
    expect(builds()).toHaveLength(count + 1);
    expect(readFileSync(paths().weekFile, "utf8").trim()).toBe(isoWeek(clock.now()));
  });
});

describe("the base tag", () => {
  it("follows the bundle's bytes, recomputed at most once an hour", async () => {
    const images = make();
    await images.resolve("scout-0001", [], "thread");
    const first = tagOf("base");
    writeFileSync(join(paths().bundle, "package.json"), '{"v":2}');
    await images.resolve("scout-0001", [], "thread");
    expect(builds().filter((b) => b.layer === "base")).toHaveLength(1);
    await clock.advance(3_600_001);
    await images.resolve("scout-0001", [], "thread");
    const bases = builds().filter((b) => b.layer === "base");
    expect(bases).toHaveLength(2);
    expect(bases[1]?.tag).not.toBe(first);
  });
});

describe("resolve: reports to the launch it serves", () => {
  const observer = (seen: string[]) => ({
    skipped: () => void seen.push("skipped"),
    waiting: (position: number | null) => void seen.push(`wait:${position}`),
    building: (tag: string) => void seen.push(`building:${tag}`),
  });

  it("resolve reports image_build waiting while another build holds the queue", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => void (release = resolve));
    let first = true;
    fake.handle("image.build", async (request) => {
      if (request.op !== "image.build") return {};
      if (request.layer === "agent" && first) {
        first = false;
        await held;
      }
      fake.images.add(request.tag);
      return { tag: request.tag };
    });
    const images = make();
    const one = images.resolve("a-0001", ["git"], "thread");
    await vi.waitFor(() => expect(builds().some((b) => b.layer === "agent")).toBe(true));
    const seen: string[] = [];
    const two = images.resolve("b-0002", ["curl"], "thread", observer(seen));
    await vi.waitFor(() => expect(seen).toEqual(["wait:1"]));
    release();
    await Promise.all([one, two]);
    const tag = await two;
    expect(seen).toEqual(["wait:1", "wait:null", `building:${tag}`]);
  });

  it("reports skipped for an image that is built, and for a thread VM that already runs", async () => {
    const images = make();
    const tag = await images.resolve("a-0001", ["git"], "thread");
    const built: string[] = [];
    await images.resolve("a-0001", ["git"], "thread", observer(built));
    expect(built).toEqual(["skipped"]);
    images.started("a-0001", tag);
    const running: string[] = [];
    await images.resolve("a-0001", ["git"], "thread", observer(running));
    expect(running).toEqual(["skipped"]);
  });

  it("reports nothing skipped when it builds", async () => {
    const seen: string[] = [];
    const tag = await make().resolve("a-0001", ["git"], "thread", observer(seen));
    expect(seen).toEqual([`building:${tag}`]);
  });

  it("a base build line reaches the image step", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => void (release = resolve));
    fake.handle("image.build", async (request) => {
      if (request.op !== "image.build") return {};
      if (request.layer === "base") await held;
      fake.images.add(request.tag);
      return { tag: request.tag };
    });
    fake.handle("image.progress", (request) => ({
      building: true,
      lines: 1,
      last:
        request.op === "image.progress" && request.tag.startsWith("pap-agent-base-")
          ? { line: "#4 RUN apt-get upgrade", at: clock.now() }
          : null,
    }));
    const lines: string[] = [];
    const resolving = make().resolve("a-0001", [], "thread", {
      ...observer([]),
      line: (line: string) => void lines.push(line),
    });
    await vi.waitFor(() => expect(builds().some((b) => b.layer === "base")).toBe(true));
    await clock.advance(2000);
    expect(lines).toEqual(["#4 RUN apt-get upgrade"]);
    release();
    await resolving;
  });
});
