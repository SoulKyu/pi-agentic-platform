import { describe, expect, it } from "vitest";
import { createPromptQueue, type QueuedPrompt } from "./prompt-queue.ts";

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const entry = (name: string, events: string[], prepare?: () => Promise<void>): QueuedPrompt => ({
  ...(prepare ? { prepare } : {}),
  start: () => void events.push(`start ${name}`),
  drop: () => void events.push(`drop ${name}`),
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("prompt queue (M8R107)", () => {
  it("starts a text prompt with nothing ahead before push returns", () => {
    const events: string[] = [];
    createPromptQueue(() => {}).push(entry("a", events));
    expect(events).toEqual(["start a"]);
  });

  it("holds a text prompt behind an image prompt's preparation, then runs both in order", async () => {
    const events: string[] = [];
    const queue = createPromptQueue(() => {});
    const preparing = gate();
    queue.push(entry("image", events, () => preparing.promise));
    queue.push(entry("text", events));
    await settle();
    expect(events).toEqual([]);
    preparing.open();
    await settle();
    expect(events).toEqual(["start image", "start text"]);
  });

  it("drops what waits, the preparing one included, and starts a later prompt at once: nothing dropped will ever reach Pi", async () => {
    const events: string[] = [];
    const queue = createPromptQueue(() => {});
    const preparing = gate();
    queue.push(entry("image", events, () => preparing.promise));
    queue.push(entry("text", events));
    queue.dropWaiting();
    expect(events).toEqual(["drop image", "drop text"]);
    queue.push(entry("after", events));
    expect(events).toEqual(["drop image", "drop text", "start after"]);
    preparing.open();
    await settle();
    expect(events).toEqual(["drop image", "drop text", "start after"]);
  });

  it("logs a start that throws once and still starts the next prompt", async () => {
    const events: string[] = [];
    const lines: string[] = [];
    const queue = createPromptQueue((line) => lines.push(line));
    const preparing = gate();
    queue.push({
      prepare: () => preparing.promise,
      start: () => {
        throw new Error("boom");
      },
      drop: () => {},
    });
    queue.push(entry("next", events));
    preparing.open();
    await settle();
    expect(events).toEqual(["start next"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("prompt start failed");
  });

  it("starts a text prompt synchronously again once idle", async () => {
    const events: string[] = [];
    const queue = createPromptQueue(() => {});
    queue.push(entry("image", events, async () => {}));
    await settle();
    queue.push(entry("text", events));
    expect(events).toEqual(["start image", "start text"]);
  });
});

describe("prompt queue: a start that returns a promise (M8R107)", () => {
  it("holds the prompts behind it until the promise settles", async () => {
    const events: string[] = [];
    const queue = createPromptQueue(() => {});
    const accepted = gate();
    queue.push({
      prepare: async () => {},
      start: () => {
        events.push("start image");
        return accepted.promise;
      },
      drop: () => {},
    });
    queue.push(entry("text", events));
    await settle();
    expect(events).toEqual(["start image"]);
    accepted.open();
    await settle();
    expect(events).toEqual(["start image", "start text"]);
  });

  it("logs a rejected start and still starts the next prompt", async () => {
    const events: string[] = [];
    const lines: string[] = [];
    const queue = createPromptQueue((line) => lines.push(line));
    queue.push({
      prepare: async () => {},
      start: () => Promise.reject(new Error("late boom")),
      drop: () => {},
    });
    queue.push(entry("next", events));
    await settle();
    expect(events).toEqual(["start next"]);
    expect(lines).toEqual(["pi-host: prompt start failed: late boom\n"]);
  });

  it("drops what waits behind an accepted-pending prompt when an abort comes", async () => {
    const events: string[] = [];
    const queue = createPromptQueue(() => {});
    const accepted = gate();
    queue.push({ prepare: async () => {}, start: () => accepted.promise, drop: () => {} });
    queue.push(entry("text", events));
    await settle();
    queue.dropWaiting();
    accepted.open();
    await settle();
    expect(events).toEqual(["drop text"]);
  });
});

describe("prompt queue: a Stop ends the hold on a prompt Pi never answers (M8R107, MC22)", () => {
  it("starts a text prompt at once after dropWaiting, though the held start never settles", async () => {
    const events: string[] = [];
    const queue = createPromptQueue(() => {});
    queue.push({ prepare: async () => {}, start: () => new Promise<void>(() => {}), drop: () => {} });
    queue.push(entry("behind", events));
    await settle();
    queue.dropWaiting();
    expect(events).toEqual(["drop behind"]);
    queue.push(entry("after", events));
    expect(events).toEqual(["drop behind", "start after"]);
    await settle();
    expect(events).toEqual(["drop behind", "start after"]);
  });
});
