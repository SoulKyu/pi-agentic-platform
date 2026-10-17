import { describe, expect, it } from "vitest";
import { fakeFetch, fixture, NEXT_URL, routesFor, runCmd, STABLE_URL } from "../testing/update-feed.ts";
import { makeCheckCommand } from "./check-command.ts";

const run = (args: string[], version: string, served: ReturnType<typeof fakeFetch>, env = {}) =>
  runCmd(makeCheckCommand({ fetch: served.fetch, version }), args, { env });

describe("pap update check", () => {
  it("says an update is available, with the versions, and exits 0", async () => {
    const served = fakeFetch(routesFor(fixture()));
    const result = await run([], "1.0.0", served);
    expect(result.code).toBe(0);
    expect(result.out).toContain("current: 1.0.0");
    expect(result.out).toContain("latest: 1.1.0 (stable,");
    expect(result.out).toContain("an update is available");
    expect(result.out).toContain("pap update install");
  });

  it("prints the release notes URL normalised: an ESC or BEL in the feed's notes never reaches the terminal raw", async () => {
    const base = fixture();
    const notes = `${base.feed.notes}/x\u001b[2J\u0007y`;
    const served = fakeFetch(routesFor({ ...base, feed: { ...base.feed, notes } }));
    const result = await run([], "1.0.0", served);
    expect(result.code).toBe(0);
    // eslint-disable-next-line no-control-regex -- the point of the test
    expect(result.out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expect(result.out).toContain("release notes: https://github.com/");
  });

  it("says up to date and ahead of the feed, exit 0 either way", async () => {
    const served = fakeFetch(routesFor(fixture()));
    const same = await run([], "1.1.0", served);
    expect([same.code, same.out]).toEqual([0, expect.stringContaining("pap is up to date")]);
    const ahead = await run([], "2.0.0", served);
    expect([ahead.code, ahead.out]).toEqual([0, expect.stringContaining("newer than the feed")]);
  });

  it("uses the next feed for --channel next and for PAP_UPDATE_CHANNEL", async () => {
    const next = fixture({ channel: "next", version: "1.2.0-next.3" });
    const served = fakeFetch(routesFor(next));
    expect((await run(["--channel", "next"], "1.1.0", served)).out).toContain("latest: 1.2.0-next.3 (next,");
    await run([], "1.1.0", served, { PAP_UPDATE_CHANNEL: "next" });
    expect(served.calls).toEqual([NEXT_URL, NEXT_URL]);
  });

  it("is a usage error for a channel that does not exist", async () => {
    const served = fakeFetch({});
    const result = await run(["--channel", "beta"], "1.0.0", served);
    expect(result.code).toBe(64);
    expect(served.calls).toEqual([]);
  });

  it("exits 1 with the code word only when the feed cannot be read", async () => {
    const served = fakeFetch({
      [STABLE_URL]: () => new Response("<html>secret portal</html>", { status: 503 }),
    });
    const result = await run([], "1.0.0", served);
    expect(result.code).toBe(1);
    expect(result.err).toBe("pap: cannot read the update feed (status)\n");
    expect(result.out).toBe("");
  });

  it("refuses a positional argument", async () => {
    expect((await run(["now"], "1.0.0", fakeFetch({}))).code).toBe(64);
  });
});
