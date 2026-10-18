import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeFetch, fixture, routesFor, STABLE_URL } from "./cli/testing/update-feed.ts";
import { createFakeClock } from "./kernel/clock.ts";
import type { LogFields, Logger } from "./kernel/logger.ts";
import { VERSION } from "./kernel/version.ts";
import {
  LastCheck,
  startUpdateCheck,
  UPDATE_CHECK_DEFAULT,
  type UpdateCheckOptions,
} from "./update-check.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-update-check-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Line {
  level: string;
  msg: string;
  fields: LogFields | undefined;
}

function recorder() {
  const lines: Line[] = [];
  const logger: Logger = {
    debug: (msg, fields) => void lines.push({ level: "debug", msg, fields }),
    info: (msg, fields) => void lines.push({ level: "info", msg, fields }),
    warn: (msg, fields) => void lines.push({ level: "warn", msg, fields }),
    error: (msg, fields) => void lines.push({ level: "error", msg, fields }),
    child: () => logger,
  };
  return { logger, lines };
}

function bed(options: Partial<UpdateCheckOptions> = {}, f = fixture()) {
  const clock = createFakeClock();
  const { logger, lines } = recorder();
  const served = fakeFetch(routesFor(f));
  const started = startUpdateCheck({
    clock,
    logger,
    env: { PAP_UPDATE_CHECK: "1" },
    home,
    version: "1.0.0",
    dev: false,
    fetch: served.fetch,
    ...options,
  });
  return { clock, lines, served, started };
}

const lastCheck = () => join(home, "update", "last-check.json");

describe("when nothing is scheduled", () => {
  it.each([
    ["dev", { dev: true }],
    ["version 0.0.0", { version: "0.0.0" }],
    ["PAP_UPDATE_CHECK=0", { env: { PAP_UPDATE_CHECK: "0" } }],
    ["PAP_UPDATE_CHECK=0 even when the default is on", { env: { PAP_UPDATE_CHECK: "0" }, defaultOn: true }],
    ["unset with the default injected as false", { env: {}, defaultOn: false }],
    ["any other value", { env: { PAP_UPDATE_CHECK: "yes" } }],
  ] as const)("%s", async (_name, options) => {
    const { clock, served } = bed(options);
    expect(clock.pending()).toBe(0);
    await clock.advance(3 * DAY);
    expect(served.calls).toEqual([]);
  });

  it("the shipped default is on now that the v1 flip is done", () => {
    expect(UPDATE_CHECK_DEFAULT).toBe(true);
  });
});

describe("when it is on", () => {
  it("is on for PAP_UPDATE_CHECK=1, and for unset only when the default is true", () => {
    expect(bed({ env: { PAP_UPDATE_CHECK: "1" } }).clock.pending()).toBe(1);
    expect(bed({ env: {}, defaultOn: true }).clock.pending()).toBe(1);
  });

  it("the first run is 10 minutes after boot, then every 24 hours", async () => {
    const { clock, served } = bed();
    await clock.advance(10 * MIN - 1);
    expect(served.calls).toEqual([]);
    await clock.advance(1);
    expect(served.calls).toEqual([STABLE_URL]);
    await clock.advance(DAY - 1);
    expect(served.calls).toHaveLength(1);
    await clock.advance(1);
    expect(served.calls).toHaveLength(2);
    await clock.advance(DAY);
    expect(served.calls).toHaveLength(3);
  });

  it("logs update_available at info only when newer, and writes last-check.json 0600", async () => {
    const { clock, lines } = bed();
    await clock.advance(10 * MIN);
    expect(lines).toEqual([
      {
        level: "info",
        msg: "update_available",
        fields: { current: "1.0.0", latest: "1.1.0", channel: "stable" },
      },
    ]);
    const written = JSON.parse(readFileSync(lastCheck(), "utf8")) as Record<string, string>;
    expect(written).toEqual({
      at: new Date(clock.now()).toISOString(),
      channel: "stable",
      current: "1.0.0",
      latest: "1.1.0",
      status: "newer",
    });
    expect(statSync(lastCheck()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "update")).mode & 0o777).toBe(0o700);
  });

  it("says nothing when current or ahead, but still records the answer", async () => {
    for (const [version, status] of [
      ["1.1.0", "current"],
      ["1.2.0", "older"],
    ] as const) {
      const { clock, lines } = bed({ version });
      await clock.advance(10 * MIN);
      expect(lines).toEqual([]);
      expect((JSON.parse(readFileSync(lastCheck(), "utf8")) as { status: string }).status).toBe(status);
    }
  });

  it("writes only the version string from the feed", async () => {
    const f = fixture();
    const hostile = {
      ...f.feed,
      notes: "https://github.com/SoulKyu/pi-agentic-platform/releases/x?y=secret",
    };
    const { clock } = bed({}, { ...f, feed: hostile });
    await clock.advance(10 * MIN);
    const text = readFileSync(lastCheck(), "utf8");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("github.com");
  });

  it("uses the channel of PAP_UPDATE_CHANNEL", async () => {
    const f = fixture({ channel: "next", version: "1.1.0-next.2" });
    const { clock, lines } = bed({ env: { PAP_UPDATE_CHECK: "1", PAP_UPDATE_CHANNEL: "next" } }, f);
    await clock.advance(10 * MIN);
    expect(lines[0]?.fields).toMatchObject({ channel: "next", latest: "1.1.0-next.2" });
  });

  it("an unknown channel falls back to stable", async () => {
    const { clock, served } = bed({ env: { PAP_UPDATE_CHECK: "1", PAP_UPDATE_CHANNEL: "nightly" } });
    await clock.advance(10 * MIN);
    expect(served.calls).toEqual([STABLE_URL]);
  });
});

describe("failures", () => {
  it("a failing fetch logs update_check_failed at debug with a code, never throws, writes nothing", async () => {
    const { clock, lines } = bed({
      fetch: async () => {
        throw new TypeError("fetch failed: /secret/path");
      },
    });
    await clock.advance(10 * MIN);
    expect(lines).toEqual([{ level: "debug", msg: "update_check_failed", fields: { code: "network" } }]);
    expect(existsSync(lastCheck())).toBe(false);
  });

  it("a feed that is not the schema: code feed_invalid, nothing above debug", async () => {
    const served = fakeFetch({ [STABLE_URL]: "<html>portal</html>" });
    const { clock, lines } = bed({ fetch: served.fetch });
    await clock.advance(10 * MIN);
    expect(lines.map((l) => [l.level, l.msg, l.fields])).toEqual([
      ["debug", "update_check_failed", { code: "feed_invalid" }],
    ]);
  });

  it("a fetch that throws at once is a network code and never escapes", async () => {
    const { clock, lines } = bed({
      fetch: () => {
        throw new RangeError("boom");
      },
    });
    await clock.advance(10 * MIN);
    expect(lines).toEqual([{ level: "debug", msg: "update_check_failed", fields: { code: "network" } }]);
  });

  it("a state file that cannot be written is a debug line and the daemon is untouched", async () => {
    writeFileSync(join(home, "blocked"), "a file where the home should be");
    const { clock, lines } = bed({ home: join(home, "blocked") });
    await expect(clock.advance(10 * MIN)).resolves.toBeUndefined();
    expect(lines.filter((l) => l.level !== "debug" && l.msg !== "update_available")).toEqual([]);
    expect(lines.some((l) => l.msg === "update_check_failed" && l.fields?.code === "state_write")).toBe(true);
  });

  it("100 failures do not grow the timers: one pending, one fetch per run", async () => {
    let asked = 0;
    const { clock, lines } = bed({
      fetch: async () => {
        asked++;
        return new Response("down", { status: 503 });
      },
    });
    await clock.advance(10 * MIN);
    for (let i = 1; i < 100; i++) {
      expect(clock.pending()).toBe(1);
      await clock.advance(DAY);
    }
    expect(asked).toBe(100);
    expect(clock.pending()).toBe(1);
    expect(lines).toHaveLength(100);
    expect(lines.every((l) => l.level === "debug")).toBe(true);
  });
});

describe("stop", () => {
  it("clears the timer: nothing runs afterwards", async () => {
    const { clock, started, served } = bed();
    started.stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(3 * DAY);
    expect(served.calls).toEqual([]);
  });

  it("stop between runs stops the schedule", async () => {
    const { clock, started, served } = bed();
    await clock.advance(10 * MIN);
    started.stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(3 * DAY);
    expect(served.calls).toHaveLength(1);
  });

  it("stop during a request: the aborted run logs nothing and writes nothing, and schedules nothing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { clock, started, lines } = bed({
      fetch: async (_url, init) => {
        await gate;
        if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
        return new Response("late");
      },
    });
    await clock.advance(10 * MIN);
    started.stop();
    release();
    await clock.advance(1);
    expect(lines).toEqual([]);
    expect(existsSync(lastCheck())).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("stop during a request that still answers: nothing is logged or written", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const f = fixture();
    const { clock, started, lines } = bed({
      fetch: async () => {
        await gate;
        return new Response(JSON.stringify(f.feed));
      },
    });
    await clock.advance(10 * MIN);
    started.stop();
    release();
    await clock.advance(1);
    expect(lines).toEqual([]);
    expect(existsSync(lastCheck())).toBe(false);
  });

  it("stop is safe to call twice and when nothing was scheduled", () => {
    const a = bed({ dev: true }).started;
    a.stop();
    a.stop();
    const b = bed().started;
    b.stop();
    b.stop();
  });
});

describe("the version the daemon passes to the writer", () => {
  it("the real VERSION satisfies LastCheck.current, so last-check.json can be written (a failure is only a debug line)", () => {
    const parsed = LastCheck.shape.current.safeParse(VERSION);
    expect(parsed.success).toBe(true);
  });
});
