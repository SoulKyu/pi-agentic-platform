import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { face, fakeFetcher, GSTATIC, woff2 } from "./modules/fonts/testing/fake-fetcher.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import { httpRequest } from "./testing/http-client.ts";

let t: TestDaemon;
let fetcher: ReturnType<typeof fakeFetcher>;
const newFetcher = () =>
  fakeFetcher({
    "https://fonts.googleapis.com/css2": face(`${GSTATIC}/fake/v1/a.woff2`, { range: "U+0000-00FF" }),
    [`${GSTATIC}/fake/v1/a.woff2`]: woff2(300),
  });
beforeEach(async () => {
  fetcher = newFetcher();
  t = await startTestDaemon({ steps: [] }, { deps: { fontsFetcher: fetcher } });
});
afterEach(async () => {
  await t.stop();
});

const appearance = (uiFont: string) => ({
  mode: "night",
  darkTheme: "night",
  lightTheme: "day",
  customThemes: [],
  uiFont,
  monoFont: "system",
  uppercaseLabels: true,
  grid: true,
  railPosition: "left",
  avatarStyle: "outlined",
  toolDetail: "compact",
});

describe("fonts over /ws and HTTP", () => {
  it("adds a family, serves it on the daemon's own origin, lets the appearance name it, then removes it", async () => {
    const client = await t.connect(await t.login());
    expect(await client.call("fonts.list", {})).toMatchObject({ ok: true, result: { families: [] } });
    const added = await client.call("fonts.add", { family: "Fake Sans" });
    expect(added).toMatchObject({
      ok: true,
      result: { slug: "fake-sans", family: "Fake Sans", files: 1, bytes: 300 },
    });
    expect(statSync(join(t.home, "fonts", "fake-sans", "font.css")).mode & 0o777).toBe(0o600);

    const css = await httpRequest(`${t.base}/fonts/fake-sans/font.css`);
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.headers["content-security-policy"]).toContain("font-src 'self';");
    expect(css.body).toContain('font-family: "Fake Sans"');
    const file = /\/fonts\/fake-sans\/([0-9a-f]{16}\.woff2)/.exec(css.body)?.[1] ?? "";
    const font = await httpRequest(`${t.base}/fonts/fake-sans/${file}`);
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect(await httpRequest(`${t.base}/fonts/fake-sans/..%2f..%2fdb`)).toMatchObject({ status: 404 });
    expect(await httpRequest(`${t.base}/fonts/nope/font.css`)).toMatchObject({ status: 404 });

    expect(
      await client.call("settings.set", {
        key: "appearance",
        value: appearance("custom:fake-sans"),
        baseRevision: 0,
      } as never),
    ).toMatchObject({ ok: true });
    expect(
      await client.call("settings.set", {
        key: "appearance",
        value: appearance("custom:../x"),
        baseRevision: 1,
      } as never),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });

    expect(await client.call("fonts.remove", { slug: "fake-sans" })).toMatchObject({ ok: true });
    expect(await httpRequest(`${t.base}/fonts/fake-sans/font.css`)).toMatchObject({ status: 404 });
    expect(await client.call("fonts.remove", { slug: "fake-sans" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("refuses a bearer token on every fonts method, even with settings permissions", async () => {
    const cookie = await t.login();
    const owner = await t.connect(cookie);
    await t.confirmStepUp(cookie);
    const created = await owner.call("auth.tokens.create", {
      name: "ci",
      permissions: ["settings:read", "settings:operate"],
      expiresInDays: 7,
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    const bot = await t.connectBearer((created.result as { value: string }).value);
    for (const [method, params] of [
      ["fonts.list", {}],
      ["fonts.add", { family: "Fake Sans" }],
      ["fonts.remove", { slug: "fake-sans" }],
    ] as const)
      expect(await bot.call(method, params as never), method).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    expect(fetcher.calls).toEqual([]);
  });

  it("answers network when the fetcher fails, and installs nothing", async () => {
    const down = await startTestDaemon({ steps: [] }); // the harness default fetcher refuses everything
    try {
      const client = await down.connect(await down.login());
      expect(await client.call("fonts.add", { family: "Fake Sans" })).toMatchObject({
        ok: false,
        error: { code: "network" },
      });
      expect(await client.call("fonts.list", {})).toMatchObject({ ok: true, result: { families: [] } });
    } finally {
      await down.stop();
    }
  });
});
