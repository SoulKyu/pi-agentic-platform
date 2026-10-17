import { describe, expect, it } from "vitest";
import { fakeFetch, fixture, NEXT_URL, routesFor, STABLE_URL } from "../testing/update-feed.ts";
import { checkForUpdate, resolveChannel, UpdateFeedError } from "./check.ts";

const ask = async (current: string, f = fixture(), channel: "stable" | "next" = f.feed.channel) => {
  const served = fakeFetch(routesFor(f));
  const answer = await checkForUpdate({ channel, current, fetch: served.fetch });
  return { answer, served };
};

describe("checkForUpdate", () => {
  it("says newer, current and older against the feed's version", async () => {
    expect((await ask("1.0.0")).answer.status).toBe("newer");
    expect((await ask("1.1.0")).answer.status).toBe("current");
    expect((await ask("1.2.0")).answer.status).toBe("older");
    expect((await ask("1.1.0-next.4")).answer.status).toBe("newer");
  });

  it("returns the parsed feed", async () => {
    const f = fixture();
    expect((await ask("1.0.0", f)).answer.feed).toEqual(f.feed);
  });

  it("asks exactly the stable URL, or exactly the next URL, once", async () => {
    const stable = await ask("1.0.0");
    expect(stable.served.calls).toEqual([STABLE_URL]);
    const next = await ask("1.0.0", fixture({ channel: "next", version: "1.1.0-next.2" }));
    expect(next.served.calls).toEqual([NEXT_URL]);
  });

  it("refuses a feed whose channel is not the one asked", async () => {
    const f = fixture({ channel: "next", version: "1.1.0-next.2" });
    const served = fakeFetch({ [STABLE_URL]: JSON.stringify(f.feed) });
    await expect(
      checkForUpdate({ channel: "stable", current: "1.0.0", fetch: served.fetch }),
    ).rejects.toMatchObject({
      code: "channel",
    });
  });

  it("refuses a feed that is not the schema, and says only the code word", async () => {
    const f = fixture();
    const bad = { ...f.feed, extra: "https://evil.example/x" };
    const served = fakeFetch({ [STABLE_URL]: JSON.stringify(bad) });
    const error = await checkForUpdate({ channel: "stable", current: "1.0.0", fetch: served.fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UpdateFeedError);
    expect((error as UpdateFeedError).code).toBe("feed_invalid");
    expect((error as Error).message).toBe("update feed refused (feed_invalid)");
  });

  it("refuses a body that is not JSON", async () => {
    const served = fakeFetch({ [STABLE_URL]: "<html>captive portal</html>" });
    await expect(
      checkForUpdate({ channel: "stable", current: "1.0.0", fetch: served.fetch }),
    ).rejects.toMatchObject({
      code: "feed_invalid",
    });
  });

  it("maps a refused fetch to its code, with no remote text in the message", async () => {
    const served = fakeFetch({
      [STABLE_URL]: () => new Response("secret body from the server", { status: 500 }),
    });
    const error = (await checkForUpdate({ channel: "stable", current: "1.0.0", fetch: served.fetch }).catch(
      (e: unknown) => e,
    )) as UpdateFeedError;
    expect(error.code).toBe("status");
    expect(error.message).toBe("update feed refused (status)");
  });

  it("maps a missing feed (404) and an offline fetch", async () => {
    const missing = fakeFetch({});
    await expect(
      checkForUpdate({ channel: "stable", current: "1.0.0", fetch: missing.fetch }),
    ).rejects.toMatchObject({
      code: "status",
    });
    await expect(
      checkForUpdate({
        channel: "stable",
        current: "1.0.0",
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("refuses a body above the feed cap", async () => {
    const served = fakeFetch({ [STABLE_URL]: Buffer.alloc(70_000, 0x20) });
    await expect(
      checkForUpdate({ channel: "stable", current: "1.0.0", fetch: served.fetch }),
    ).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("sends the pap user agent with the running version", async () => {
    const seen: string[] = [];
    const f = fixture();
    await checkForUpdate({
      channel: "stable",
      current: "1.0.0",
      fetch: async (_url, init) => {
        seen.push(init.headers["user-agent"] ?? "");
        return new Response(JSON.stringify(f.feed));
      },
    });
    expect(seen).toEqual(["pap/1.0.0"]);
  });

  it("stops when the caller's signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture();
    const error = await checkForUpdate({
      channel: "stable",
      current: "1.0.0",
      signal: controller.signal,
      fetch: async (_url, init) => {
        if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
        return new Response(JSON.stringify(f.feed));
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateFeedError);
  });
});

describe("resolveChannel", () => {
  it("takes the flag, then PAP_UPDATE_CHANNEL, then stable", () => {
    expect(resolveChannel("next", { PAP_UPDATE_CHANNEL: "stable" })).toBe("next");
    expect(resolveChannel(undefined, { PAP_UPDATE_CHANNEL: "next" })).toBe("next");
    expect(resolveChannel(undefined, {})).toBe("stable");
    expect(resolveChannel(undefined, { PAP_UPDATE_CHANNEL: "" })).toBe("stable");
  });

  it("returns null for a channel that does not exist", () => {
    expect(resolveChannel("beta", {})).toBeNull();
    expect(resolveChannel(undefined, { PAP_UPDATE_CHANNEL: "nightly" })).toBeNull();
  });
});
