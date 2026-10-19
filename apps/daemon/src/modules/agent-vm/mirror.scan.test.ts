import { afterEach, describe, expect, it, vi } from "vitest";
import { topLevelIdOf } from "./mirror-id.ts";
import { appendOf, entry, HEADER, imageEntry } from "./mirror-fixtures.ts";
import { cleanup, clock, fresh, log, MiB, open, refusals } from "./mirror-harness.ts";
import { createLineParser } from "./mirror-parse.ts";

// The byte scan of a line over 1 MiB must not run on the daemon's event loop (RT-27, AVM-E29): the module is wrapped to see
// every buffer it is given on this thread. (The parse thread has its own copy of the module.)
vi.mock("./mirror-id.ts", async (original) => {
  const module = await original<typeof import("./mirror-id.ts")>();
  return { ...module, topLevelIdOf: vi.fn(module.topLevelIdOf) };
});

afterEach(cleanup);

// Mutant M-SCAN-ON-LOOP: scan long lines in `accept` again: killed by "never scans a line over 1 MiB on this thread".
describe("a long line is scanned in the parse thread (AVM-E29)", () => {
  const dense = (id: string, extra = "") =>
    `{"type":"custom","customType":"x"${extra},"data":{${Array.from({ length: 60_000 }, (_, i) => `"k${i}":"v${i}"`).join(",")}},"id":"${id}"}\n`;

  it("never scans a line over 1 MiB on this thread, small ones still are", async () => {
    fresh();
    const parser = createLineParser({ clock, logger: log.logger });
    try {
      const mirror = open({ parser });
      const line = dense("c1");
      expect(line.length).toBeGreaterThan(MiB);
      expect(await mirror.onSessionAppend(appendOf(0, HEADER + entry("e0") + line + entry("e2")))).toBe("ok");
      expect(parser.stats().threadLines).toBe(1);
      const lengths = vi.mocked(topLevelIdOf).mock.calls.map(([bytes]) => bytes.length);
      expect(lengths.length).toBeGreaterThan(0);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(MiB);
      expect(mirror.facts().lastEntryId).toBe("e2");
    } finally {
      await parser.stop();
    }
  });

  it("still refuses a long line whose id the parse and the scan read differently", async () => {
    fresh();
    const parser = createLineParser({ clock, logger: log.logger });
    try {
      const mirror = open({ parser });
      mirror.onSessionAppend(appendOf(0, HEADER));
      const twice = dense("c1", ',"id":"c0"');
      expect(await mirror.onSessionAppend(appendOf(HEADER.length, twice))).toBe("refused");
      expect(refusals().at(-1)?.reason).toBe("not_entry");
    } finally {
      await parser.stop();
    }
  });

  it("a long image line is scanned there too", async () => {
    fresh();
    const parser = createLineParser({ clock, logger: log.logger });
    try {
      const mirror = open({ parser });
      expect(await mirror.onSessionAppend(appendOf(0, HEADER + imageEntry("img1", 3 * MiB)))).toBe("ok");
      expect(mirror.facts().lastEntryId).toBe("img1");
    } finally {
      await parser.stop();
    }
  });
});
