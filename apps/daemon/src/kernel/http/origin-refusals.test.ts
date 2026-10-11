import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createLogger } from "../logger.ts";
import { createOriginRefusalLog, ORIGIN_REFUSED_EVERY_MS } from "./origin-refusals.ts";

function setup() {
  const clock = createFakeClock();
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { clock, lines, refused: createOriginRefusalLog(logger, clock) };
}

describe("createOriginRefusalLog", () => {
  it("logs the Origin and names PAP_PUBLIC_ORIGIN", () => {
    const { lines, refused } = setup();
    refused("http", "http://192.168.1.5:7777");
    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "origin_refused",
        via: "http",
        origin: "http://192.168.1.5:7777",
        suppressed: 0,
        hint: expect.stringContaining("PAP_PUBLIC_ORIGIN"),
      }),
    ]);
  });

  it("says (none) for a request without an Origin", () => {
    const { lines, refused } = setup();
    refused("ws", undefined);
    expect(lines[0]).toMatchObject({ via: "ws", origin: "(none)" });
  });

  it("clips an Origin of any length", () => {
    const { lines, refused } = setup();
    refused("http", `http://${"a".repeat(5000)}`);
    expect(String(lines[0]?.origin)).toHaveLength(101);
    expect(String(lines[0]?.origin).endsWith("…")).toBe(true);
  });

  it("writes one line per window and path, then reports how many it swallowed", async () => {
    const { clock, lines, refused } = setup();
    for (let n = 0; n < 5; n++) refused("http", "http://evil.example");
    refused("ws", "http://evil.example");
    expect(lines.map((line) => line.via)).toEqual(["http", "ws"]);
    await clock.advance(ORIGIN_REFUSED_EVERY_MS);
    refused("http", "http://evil.example");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ via: "http", suppressed: 4 });
  });
});
