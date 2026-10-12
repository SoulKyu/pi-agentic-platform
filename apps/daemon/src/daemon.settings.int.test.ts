import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [] });
});
afterEach(async () => {
  await t.stop();
});

describe("settings over /ws", () => {
  it("round-trips the account appearance, refuses a stale write and an invalid one", async () => {
    const client = await t.connect(await t.login());
    expect(await client.call("settings.get", { key: "appearance" })).toMatchObject({
      ok: true,
      result: { value: null, revision: 0 },
    });
    const value = {
      mode: "night",
      darkTheme: "hc",
      lightTheme: "day",
      customThemes: [],
      uiFont: "manrope",
      monoFont: "system",
      uppercaseLabels: true,
      grid: false,
      railPosition: "left",
      avatarStyle: "outlined",
      toolDetail: "expanded",
    };
    expect(
      await client.call("settings.set", { key: "appearance", value, baseRevision: 0 } as never),
    ).toMatchObject({ ok: true, result: { revision: 1 } });
    expect(await client.call("settings.get", { key: "appearance" })).toMatchObject({
      ok: true,
      result: { value, revision: 1 },
    });
    expect(
      await client.call("settings.set", {
        key: "appearance",
        value: { ...value, grid: true },
        baseRevision: 0,
      } as never),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await client.call("settings.set", {
        key: "appearance",
        value: { ...value, darkTheme: "nope" },
        baseRevision: 1,
      } as never),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await client.call("settings.get", { key: "appearance" })).toMatchObject({
      ok: true,
      result: { value, revision: 1 },
    });
  });
});
