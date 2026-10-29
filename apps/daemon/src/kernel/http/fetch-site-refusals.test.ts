import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createLogger } from "../logger.ts";
import { createFetchSiteRefusalLog, FETCH_SITE_REFUSED_EVERY_MS } from "./fetch-site-refusals.ts";

function setup() {
  const clock = createFakeClock();
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { clock, lines, refused: createFetchSiteRefusalLog(logger, clock) };
}

describe("createFetchSiteRefusalLog", () => {
  it("logs the kind of site and never the header text", () => {
    const { lines, refused } = setup();
    refused("http", "same-site");
    refused("ws", `https://secret.test/${String.fromCodePoint(0x202e)}`);
    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "fetch_site_refused",
        via: "http",
        site: "same-site",
        suppressed: 0,
      }),
      expect.objectContaining({ via: "ws", site: "cross-site" }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret.test");
  });

  it("says one line per via in a window and counts the rest", async () => {
    const { clock, lines, refused } = setup();
    for (let i = 0; i < 4; i++) refused("http", "cross-site");
    refused("ws", "same-site");
    expect(lines.map((line) => line.via)).toEqual(["http", "ws"]);
    await clock.advance(FETCH_SITE_REFUSED_EVERY_MS);
    refused("http", "cross-site");
    expect(lines[2]).toMatchObject({ via: "http", suppressed: 3 });
  });
});
