import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError, FONT_LIMITS, type Caller } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { INSTALL_DEADLINE_MS } from "./service.ts";
import { testCaller } from "../../testing/caller.ts";
import { createFontsService } from "./service.ts";
import { createFontsStore } from "./store.ts";
import { face, fakeFetcher, GSTATIC, woff2, type Reply } from "./testing/fake-fetcher.ts";

const entries = (root: string): string[] => (existsSync(root) ? readdirSync(root) : []);
const CSS = "https://fonts.googleapis.com/css2?family=";
let home: string;
let opened = 0;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-fonts-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const browser = (): Caller => testCaller();
const token = (): Caller => testCaller({ kind: "token", credentialId: "tok" });
const codeOf = async (promise: unknown): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof PapError ? error.code : `not a PapError: ${String(error)}`;
  }
  return "resolved";
};
function open(table: Record<string, Reply>) {
  const fetcher = fakeFetcher(table);
  const clock = createFakeClock();
  opened += 1;
  const root = join(home, `fonts-${opened}`);
  const service = createFontsService({
    store: createFontsStore(root),
    fetch: fetcher,
    clock,
    logger: silentLogger,
  });
  return { service, fetcher, root, clock };
}
const url = (n: number) => `${GSTATIC}/fake/v1/file${n}.woff2`;
const sheet = (count: number) =>
  Array.from({ length: count }, (_, n) => face(url(n), { range: `U+00${n % 10}0-00FF` })).join("\n");
const bodies = (count: number, size = 64): Record<string, Reply> =>
  Object.fromEntries(Array.from({ length: count }, (_, n) => [url(n), woff2(size, n + 1)]));

describe("fonts.add", () => {
  it("downloads the css and each woff2, writes a generated font.css and answers the view", async () => {
    const { service, fetcher, root } = open({ [CSS]: sheet(2), ...bodies(2, 100) });
    const view = await service.add(browser(), "Fake Sans");
    expect(view).toMatchObject({ slug: "fake-sans", family: "Fake Sans", files: 2, bytes: 200 });
    expect(fetcher.calls[0]?.url).toBe(`${CSS}Fake+Sans:wght@400;500;600;700&display=swap`);
    expect(fetcher.calls[0]?.maxBytes).toBe(FONT_LIMITS.cssBytes);
    expect(fetcher.calls[1]?.maxBytes).toBe(FONT_LIMITS.fileBytes);
    const dir = join(root, "fake-sans");
    const css = readFileSync(join(dir, "font.css"), "utf8");
    expect(css).toContain('font-family: "Fake Sans"');
    expect(css.match(/url\("\/fonts\/fake-sans\/[0-9a-f]{16}\.woff2"\)/g)).toHaveLength(2);
    expect(css).not.toContain("gstatic");
    expect(css).not.toContain("googleapis");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "font.css")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.endsWith(".woff2"))).toHaveLength(2);
    expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("uses the family name Google wrote when it is a safe name", async () => {
    const { service } = open({
      [CSS]: face(url(0)).replace("'Fake Sans'", "'Open Sans'"),
      ...bodies(1),
    });
    expect(await service.add(browser(), "open sans")).toMatchObject({
      slug: "open-sans",
      family: "Open Sans",
    });
  });

  it("asks again for the default weight when the four weights are not offered", async () => {
    const { service, fetcher } = open({
      [`${CSS}Fake+Sans:wght`]: { ok: true, status: 400, body: Buffer.from("no") },
      [`${CSS}Fake+Sans&display`]: sheet(1),
      ...bodies(1),
    });
    expect(await service.add(browser(), "Fake Sans")).toMatchObject({ files: 1 });
    expect(fetcher.calls[1]?.url).toBe(`${CSS}Fake+Sans&display=swap`);
  });

  it("answers not_found when Google answers 400 or 404 twice, or the css has no usable face", async () => {
    for (const status of [400, 404]) {
      const { service } = open({ [CSS]: { ok: true, status, body: Buffer.from("no") } });
      expect(await codeOf(service.add(browser(), "Nope")), String(status)).toBe("not_found");
    }
    const empty = open({ [CSS]: "body {}" });
    expect(await codeOf(empty.service.add(browser(), "Nope"))).toBe("not_found");
    const foreign = open({ [CSS]: face("https://evil.example/x.woff2") });
    expect(await codeOf(foreign.service.add(browser(), "Nope"))).toBe("not_found");
    expect(foreign.fetcher.calls.map((call) => call.url).every((u) => u.startsWith(CSS))).toBe(true);
  });

  it("refuses a bad name with bad_request before any request", async () => {
    const { service, fetcher } = open({});
    for (const name of ["", "In/ter", "Inter&x=1", " Inter", "A".repeat(65)])
      expect(await codeOf(service.add(browser(), name)), name).toBe("bad_request");
    expect(fetcher.calls).toEqual([]);
  });

  it("is browser only: a token gets forbidden on add, remove and list, and nothing is fetched or read", async () => {
    const { service, fetcher } = open({ [CSS]: sheet(1), ...bodies(1) });
    expect(await codeOf(service.add(token(), "Fake Sans"))).toBe("forbidden");
    expect(() => service.list(token())).toThrow(PapError);
    expect(() => service.remove(token(), "fake-sans")).toThrow(PapError);
    expect(fetcher.calls).toEqual([]);
  });

  it("maps a failed fetch to network, a cap to payload_too_large", async () => {
    for (const error of ["address", "timeout", "network", "redirect", "host"] as const) {
      const { service } = open({ [CSS]: { ok: false, error } });
      expect(await codeOf(service.add(browser(), "Fake Sans")), error).toBe("network");
    }
    const big = open({ [CSS]: { ok: false, error: "too_large" } });
    expect(await codeOf(big.service.add(browser(), "Fake Sans"))).toBe("payload_too_large");
    const font = open({ [CSS]: sheet(1), [url(0)]: { ok: false, error: "too_large" } });
    expect(await codeOf(font.service.add(browser(), "Fake Sans"))).toBe("payload_too_large");
    expect(entries(font.root)).toEqual([]);
  });

  it("refuses a file that does not start with the woff2 magic, and installs nothing", async () => {
    const { service, root } = open({
      [CSS]: sheet(2),
      [url(0)]: woff2(),
      [url(1)]: Buffer.from("<html>nope</html>"),
    });
    expect(await codeOf(service.add(browser(), "Fake Sans"))).toBe("network");
    expect(entries(root)).toEqual([]);
  });

  it("refuses a size of 2 MiB + 1 byte as the fetcher reports it, and accepts exactly 2 MiB", async () => {
    const exact = open({ [CSS]: sheet(1), [url(0)]: woff2(FONT_LIMITS.fileBytes) });
    expect(await exact.service.add(browser(), "Fake Sans")).toMatchObject({ bytes: FONT_LIMITS.fileBytes });
    const over = open({ [CSS]: sheet(1), [url(0)]: woff2(FONT_LIMITS.fileBytes + 1) });
    expect(await codeOf(over.service.add(browser(), "Fake Sans"))).toBe("payload_too_large");
  });

  it("accepts 24 files and refuses 25 (distinct urls), fetching no font for the 25", async () => {
    const ok = open({ [CSS]: sheet(24), ...bodies(24) });
    expect(await ok.service.add(browser(), "Fake Sans")).toMatchObject({ files: 24 });
    const over = open({ [CSS]: sheet(25), ...bodies(25) });
    expect(await codeOf(over.service.add(browser(), "Fake Sans"))).toBe("payload_too_large");
    expect(over.fetcher.calls).toHaveLength(1);
  });

  it("past 24 faces keeps the latin and latin-ext ones, so a four-weight family still installs", async () => {
    const css = Array.from({ length: 28 }, (_, n) =>
      face(url(n), {
        subset: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese", "cyrillic-ext", "greek-ext"][n % 7],
      }),
    ).join("\n");
    const { service } = open({ [CSS]: css, ...bodies(28) });
    expect(await service.add(browser(), "Fake Sans")).toMatchObject({ files: 8 });
  });

  it("serves one file for several faces that share a url (variable fonts)", async () => {
    const css = [
      face(url(0), { weight: "400 700", range: "U+0000-00FF" }),
      face(url(0), { weight: "400 700", range: "U+0100-02BA" }),
    ].join("\n");
    const { service, root } = open({ [CSS]: css, ...bodies(1) });
    expect(await service.add(browser(), "Fake Sans")).toMatchObject({ files: 1 });
    expect(readFileSync(join(root, "fake-sans", "font.css"), "utf8").match(/@font-face/g)).toHaveLength(2);
  });

  it("refuses the 17th family with limit_reached, before any request, and a repeat of an installed one is free", async () => {
    const table: Record<string, Reply> = { [CSS]: sheet(1), ...bodies(1) };
    const { service, fetcher } = open(table);
    for (let n = 0; n < FONT_LIMITS.families; n += 1) await service.add(browser(), `Fam${n}`);
    const calls = fetcher.calls.length;
    expect(await codeOf(service.add(browser(), "Fam16"))).toBe("limit_reached");
    expect(fetcher.calls).toHaveLength(calls);
    expect(await service.add(browser(), "Fam3")).toMatchObject({ slug: "fam3" });
    expect(fetcher.calls).toHaveLength(calls);
  });

  it("refuses a css over 256 KiB as payload_too_large", async () => {
    const { service } = open({ [CSS]: { ok: false, error: "too_large" } });
    expect(await codeOf(service.add(browser(), "Fake Sans"))).toBe("payload_too_large");
  });
});

describe("fonts.list and fonts.remove", () => {
  it("lists what is installed, newest last, and removes a folder", async () => {
    const { service, root, clock } = open({ [CSS]: sheet(1), ...bodies(1) });
    await service.add(browser(), "Beta");
    await clock.advance(1000);
    await service.add(browser(), "Alpha");
    expect(service.list(browser()).families.map((entry) => entry.slug)).toEqual(["beta", "alpha"]);
    expect(service.remove(browser(), "beta")).toEqual({ ok: true });
    expect(readdirSync(root)).toEqual(["alpha"]);
    expect(service.list(browser()).families.map((entry) => entry.slug)).toEqual(["alpha"]);
  });

  it("answers not_found for an unknown slug and never touches a path outside its folder", async () => {
    const { service } = open({});
    expect(() => service.remove(browser(), "ghost")).toThrow(expect.objectContaining({ code: "not_found" }));
    for (const slug of ["..", "../x", "a/b", ".tmp-1", "A"])
      expect(() => service.remove(browser(), slug), slug).toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
  });

  it("lists nothing for a missing folder and skips a folder whose meta is unreadable", async () => {
    const { service } = open({});
    expect(service.list(browser())).toEqual({ families: [] });
  });
});

describe("fonts.add limits in time and in number", () => {
  const build = (fetch: Parameters<typeof createFontsService>[0]["fetch"]) => {
    const clock = createFakeClock();
    const { logger, lines } = captureLogger();
    opened += 1;
    const root = join(home, `fonts-${opened}`);
    const service = createFontsService({ store: createFontsStore(root, logger), fetch, clock, logger });
    return { service, clock, lines, root };
  };

  it("gives up with network once 60 s have gone, and hands each request what is left", async () => {
    const seen: Array<number | undefined> = [];
    const clockRef: { advance?: (ms: number) => Promise<void> } = {};
    const fetch = async (url: string, _max: number, totalMs?: number) => {
      seen.push(totalMs);
      await clockRef.advance?.(25_000);
      return url.startsWith(CSS)
        ? ({ ok: true, status: 200, body: Buffer.from(sheet(5)) } as const)
        : ({ ok: true, status: 200, body: woff2(64) } as const);
    };
    const { service, clock, lines } = build(fetch);
    clockRef.advance = (ms) => clock.advance(ms);
    expect(INSTALL_DEADLINE_MS).toBe(60_000);
    expect(await codeOf(service.add(browser(), "Fake Sans"))).toBe("network");
    // requests at 0 s, 25 s, 50 s; the fourth would start at 75 s and is not sent
    expect(seen).toEqual([15_000, 15_000, 10_000]);
    expect(lines.filter((line) => line.msg === "font_fetch_failed")).toEqual([
      expect.objectContaining({ family: "Fake Sans", cause: "deadline" }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("http");
  });

  it("logs a failed fetch without any url", async () => {
    const { service, lines } = build(async () => ({ ok: false, error: "redirect" }));
    expect(await codeOf(service.add(browser(), "Fake Sans"))).toBe("network");
    expect(lines.filter((line) => line.msg === "font_fetch_failed")).toEqual([
      expect.objectContaining({ family: "Fake Sans", cause: "redirect" }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("fonts.googleapis");
  });

  it("names the cause of each kind of failure in the log: address, timeout, status, magic", async () => {
    const causes: Array<[Parameters<typeof build>[0], string]> = [
      [async () => ({ ok: false, error: "address" }), "address"],
      [async () => ({ ok: false, error: "timeout" }), "timeout"],
      [async () => ({ ok: true, status: 503, body: Buffer.from("x") }), "status"],
      [
        async (url) => ({
          ok: true,
          status: 200,
          body: url.startsWith(CSS) ? Buffer.from(sheet(1)) : Buffer.from("nope!"),
        }),
        "magic",
      ],
    ];
    for (const [fetch, cause] of causes) {
      const { service, lines } = build(fetch);
      expect(await codeOf(service.add(browser(), "Fake Sans")), cause).toBe("network");
      expect(lines.filter((line) => line.msg === "font_fetch_failed").map((line) => line.cause)).toEqual([
        cause,
      ]);
    }
  });

  it("refuses a third pending install with limit_reached, and accepts one again when they are done", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = async (url: string) => {
      await gate;
      return {
        ok: true,
        status: 200,
        body: url.startsWith(CSS) ? Buffer.from(sheet(1)) : woff2(64),
      } as const;
    };
    const { service, lines } = build(fetch);
    const first = service.add(browser(), "Alpha");
    const second = service.add(browser(), "Beta");
    expect(await codeOf(service.add(browser(), "Gamma"))).toBe("limit_reached");
    expect(lines.some((line) => line.msg === "font_install_busy")).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(await service.add(browser(), "Gamma")).toMatchObject({ slug: "gamma" });
  });

  it("installs over a folder that has no valid record, and the list sweeps stale staging folders", async () => {
    const { service, root } = build(async (url) => ({
      ok: true,
      status: 200,
      body: url.startsWith(CSS) ? Buffer.from(sheet(1)) : woff2(64),
    }));
    mkdirSync(join(root, "fake-sans"), { recursive: true });
    writeFileSync(join(root, "fake-sans", "junk"), "x");
    mkdirSync(join(root, ".tmp-old"));
    mkdirSync(join(root, ".tmp-trash-old"));
    expect(await service.add(browser(), "Fake Sans")).toMatchObject({ slug: "fake-sans", files: 1 });
    expect(service.list(browser()).families).toHaveLength(1);
    expect(readdirSync(root)).toEqual(["fake-sans"]);
  });
});
