import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createKataBuild } from "./kata-build.ts";
import { createFakeVmd, type FakeVmd } from "./testing/fake-vmd.ts";
import { VmdError } from "./vmd-client.ts";

const PROFILE = `pap-agent-profile-${"1".repeat(64)}`;
const WANTED = `pap-agent-agent-${"2".repeat(64)}`;
const BOX = "11111111-1111-4111-8111-111111111111";
const BASE = `pap-agent-base-${"3".repeat(64)}`;

let clock: FakeClock;
let vmd: FakeVmd;
let release: () => void;
let lines: Array<{ line: string; at: number }>;

function make(redact: (line: string) => Promise<string> = (line) => Promise.resolve(line)) {
  const held = new Promise<void>((resolve) => (release = resolve));
  const build = createKataBuild({
    client: vmd,
    clock,
    logger: silentLogger,
    redact,
    buildOnce: async () => held,
    profileTag: () => PROFILE,
    runningTags: () => [],
    held: () => [],
    latest: new Map(),
  });
  const observe = {
    skipped: vi.fn(),
    waiting: vi.fn(),
    building: vi.fn(),
    line: (line: string, at: number) => void lines.push({ line, at }),
  };
  return { build, observe };
}

beforeEach(() => {
  clock = createFakeClock();
  vmd = createFakeVmd();
  lines = [];
});

describe("the image step's last line", () => {
  it("the image step carries the last line, polled every 2 s", async () => {
    let text = "#5 [3/4] RUN apt-get install";
    vmd.handle("image.progress", (request) => ({
      building: true,
      lines: 1,
      last:
        request.op === "image.progress" && request.tag === PROFILE ? { line: text, at: clock.now() } : null,
    }));
    const { build, observe } = make();
    const done = build.buildLayers({ tag: PROFILE }, BASE, WANTED, [], new Set(), { observe, boxId: BOX });
    await clock.advance(0);
    expect(lines).toEqual([]);
    await clock.advance(2000);
    expect(lines).toEqual([{ line: "#5 [3/4] RUN apt-get install", at: clock.now() }]);
    text = "#5 done";
    await clock.advance(2000);
    expect(lines.at(-1)?.line).toBe("#5 done");
    expect(vmd.of("image.progress").length).toBeGreaterThanOrEqual(2);
    release();
    await done;
    const asked = vmd.of("image.progress").length;
    await clock.advance(10_000);
    expect(vmd.of("image.progress")).toHaveLength(asked);
    expect(clock.pending()).toBe(0);
  });

  it("a bad_request from an old pap-vmd means no line, never a failed launch", async () => {
    vmd.handle("image.progress", () => {
      throw new VmdError("bad_request");
    });
    const { build, observe } = make();
    const done = build.buildLayers({ tag: PROFILE }, BASE, WANTED, [], new Set(), { observe, boxId: BOX });
    await clock.advance(6000);
    expect(lines).toEqual([]);
    release();
    await expect(done).resolves.toBeUndefined();
  });

  it("an observer that throws on a line is no line and no failure (A4 M4)", async () => {
    vmd.handle("image.progress", () => ({ building: true, lines: 1, last: { line: "x", at: 1 } }));
    const { build, observe } = make();
    const calls: string[] = [];
    const throwing = {
      ...observe,
      line: (line: string) => {
        calls.push(line);
        throw new Error("boom");
      },
    };
    const done = build.buildLayers({ tag: PROFILE }, BASE, WANTED, [], new Set(), {
      observe: throwing,
      boxId: BOX,
    });
    await clock.advance(2000);
    await clock.advance(2000);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    release();
    await expect(done).resolves.toBeUndefined();
  });

  it("masks the line before it leaves", async () => {
    vmd.handle("image.progress", () => ({
      building: true,
      lines: 1,
      last: { line: "token hunter2", at: 1 },
    }));
    const { build, observe } = make((line) => Promise.resolve(line.replace("hunter2", "[REDACTED]")));
    const done = build.buildLayers({ tag: PROFILE }, BASE, WANTED, [], new Set(), { observe, boxId: BOX });
    await clock.advance(2000);
    expect(lines[0]?.line).toBe("token [REDACTED]");
    release();
    await done;
  });
});

describe("the build log of a box", () => {
  it("holds the tail of the tags its launch builds, redacted, and nothing once they are built", async () => {
    vmd.handle("image.progress", (request) => ({
      building: true,
      lines: 2,
      last: { line: "b", at: 1 },
      tail: request.op === "image.progress" && request.tail === true ? ["a hunter2", "b"] : undefined,
    }));
    const { build, observe } = make((line) => Promise.resolve(line.replace("hunter2", "[REDACTED]")));
    expect(await build.tailOf(BOX)).toEqual([]);
    const done = build.buildLayers({ tag: PROFILE }, BASE, WANTED, [], new Set(), { observe, boxId: BOX });
    await clock.advance(0);
    expect(await build.tailOf(BOX)).toContain("a [REDACTED]");
    expect(await build.tailOf("another-box")).toEqual([]);
    release();
    await done;
    expect(await build.tailOf(BOX)).toEqual([]);
  });
});
