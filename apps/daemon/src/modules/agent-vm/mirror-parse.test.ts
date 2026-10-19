import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { imageEntry, userEntry } from "./mirror-fixtures.ts";
import {
  createLineParser,
  IDLE_STOP_MS,
  PARSE_TIMEOUT_MS,
  type LineParser,
  type ParseThread,
  parseThreadEntry,
} from "./mirror-parse.ts";

const MiB = 1024 * 1024;
const noNewline = (text: string) => Buffer.from(text.slice(0, -1));

let parser: LineParser | undefined;
afterEach(async () => {
  await parser?.stop();
  parser = undefined;
});

describe("the real parse thread (Review Focus 1)", () => {
  it("parses a 12 MiB line in the thread: same facts as the inline check, counted as a thread line", async () => {
    parser = createLineParser({ clock: createFakeClock(), logger: captureLogger().logger });
    const line = noNewline(imageEntry("img1", 12 * MiB));
    expect(line.length).toBeGreaterThan(12 * MiB);
    const checked = await parser.parse(line, false);
    expect(checked).toMatchObject({ ok: true, facts: { id: "img1" } });
    expect(parser.stats().threadLines).toBe(1);
    // The thread runs the same `entryFacts`: a user message gets its text hash.
    expect(checked).toMatchObject({ facts: { userText: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  });

  it("refuses with the same reasons as the inline check", async () => {
    parser = createLineParser({ clock: createFakeClock(), logger: captureLogger().logger });
    expect(await parser.parse(Buffer.from("{nope"), false)).toEqual({ ok: false, reason: "not_json" });
    expect(await parser.parse(Buffer.from("[1]"), false)).toEqual({ ok: false, reason: "not_entry" });
    expect(await parser.parse(noNewline(userEntry("u1", "x")), true)).toEqual({
      ok: false,
      reason: "no_header",
    });
  });

  it("keeps the event loop turning while it parses", async () => {
    parser = createLineParser({ clock: createFakeClock(), logger: captureLogger().logger });
    const line = noNewline(imageEntry("img1", 30 * MiB));
    let ticks = 0;
    let running = true;
    const spin = (): void => {
      if (!running) return;
      ticks++;
      setImmediate(spin);
    };
    spin();
    await parser.parse(line, false);
    running = false;
    expect(ticks).toBeGreaterThan(2);
  });
});

class FakeThread extends EventEmitter implements ParseThread {
  readonly posted: Array<{ id: number; first: boolean; length: number }> = [];
  terminated = false;
  postMessage(message: unknown): void {
    const { id, first, bytes } = message as { id: number; first: boolean; bytes: Uint8Array };
    this.posted.push({ id, first, length: bytes.length });
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  unref(): void {}
  answer(id: number, checked: unknown): void {
    this.emit("message", { id, checked });
  }
}

const fakeParser = () => {
  const threads: FakeThread[] = [];
  const clock = createFakeClock();
  const made = createLineParser({
    clock,
    logger: captureLogger().logger,
    spawn: () => {
      const thread = new FakeThread();
      threads.push(thread);
      return thread;
    },
  });
  parser = made;
  return { made, threads, clock };
};

describe("the parse thread's protocol", () => {
  it("parses one line at a time: the second waits until the first is answered", async () => {
    const { made, threads } = fakeParser();
    const first = made.parse(Buffer.alloc(2 * MiB), false);
    const second = made.parse(Buffer.alloc(3 * MiB), true);
    await Promise.resolve();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.posted).toEqual([{ id: 1, first: false, length: 2 * MiB }]);
    threads[0]?.answer(1, { ok: true, facts: { id: "a", userText: null, headerId: null } });
    expect(await first).toMatchObject({ ok: true });
    await Promise.resolve();
    expect(threads[0]?.posted.at(-1)).toEqual({ id: 2, first: true, length: 3 * MiB });
    threads[0]?.answer(2, { ok: false, reason: "no_header" });
    expect(await second).toEqual({ ok: false, reason: "no_header" });
  });

  it("does not trust an answer that is not a verdict: the line is refused", async () => {
    const { made, threads } = fakeParser();
    const pending = made.parse(Buffer.alloc(2 * MiB), false);
    await Promise.resolve();
    threads[0]?.answer(1, { ok: true, facts: { id: 7 } });
    expect(await pending).toEqual({ ok: false, reason: "not_json" });
  });

  it("fails closed when the thread dies, and starts a new one for the next line", async () => {
    const { made, threads } = fakeParser();
    const pending = made.parse(Buffer.alloc(2 * MiB), false);
    await Promise.resolve();
    threads[0]?.emit("error", new Error("out of memory"));
    expect(await pending).toEqual({ ok: false, reason: "not_json" });
    const next = made.parse(Buffer.alloc(2 * MiB), false);
    await Promise.resolve();
    expect(threads).toHaveLength(2);
    threads[1]?.answer(2, { ok: true, facts: { id: "a", userText: null, headerId: null } });
    expect(await next).toMatchObject({ ok: true });
  });

  it("refuses the line of a thread that never answers, ends that thread and goes on with the next line", async () => {
    const { made, threads, clock } = fakeParser();
    const stuck = made.parse(Buffer.alloc(2 * MiB), false);
    const waiting = made.parse(Buffer.alloc(2 * MiB), false);
    await Promise.resolve();
    await clock.advance(PARSE_TIMEOUT_MS);
    expect(await stuck).toEqual({ ok: false, reason: "not_json" });
    expect(threads[0]?.terminated).toBe(true);
    await Promise.resolve();
    expect(threads).toHaveLength(2);
    threads[1]?.answer(2, { ok: true, facts: { id: "a", userText: null, headerId: null } });
    expect(await waiting).toMatchObject({ ok: true });
    await clock.advance(PARSE_TIMEOUT_MS);
    expect(threads[1]?.terminated).toBe(false);
  });

  it("stops the thread when idle and after stop()", async () => {
    const { made, threads, clock } = fakeParser();
    const pending = made.parse(Buffer.alloc(2 * MiB), false);
    await Promise.resolve();
    threads[0]?.answer(1, { ok: true, facts: { id: "a", userText: null, headerId: null } });
    await pending;
    await clock.advance(IDLE_STOP_MS);
    expect(threads[0]?.terminated).toBe(true);
    const again = made.parse(Buffer.alloc(2 * MiB), false);
    await Promise.resolve();
    expect(threads).toHaveLength(2);
    await made.stop();
    expect(threads[1]?.terminated).toBe(true);
    expect(await again).toEqual({ ok: false, reason: "not_json" });
  });

  it("picks the .ts thread next to a .ts module and the .js one next to a .js module", () => {
    expect(parseThreadEntry("file:///m/mirror-parse.ts").pathname).toMatch(/\/m\/mirror-parse-thread\.ts$/);
    expect(parseThreadEntry("file:///m/mirror-parse.js").pathname).toMatch(/\/m\/mirror-parse-thread\.js$/);
  });
});
