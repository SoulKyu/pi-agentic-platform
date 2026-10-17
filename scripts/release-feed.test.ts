import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEED_HOSTS, FEED_REPO, FeedSchema } from "../apps/daemon/src/cli/update/feed.ts";
import { generateFeed, type FeedOptions } from "./release-feed.ts";

const ID = "0.1.0-abc1234-202610171200";
const INSTALLER = "#!/bin/sh\nexit 0\n";
const ARCHIVE = "abc";
const NOW = new Date("2026-10-17T12:00:00.000Z");
const FIXTURE_ENV = join(import.meta.dirname, "fixtures", "feed-stable.env");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let root: string;
let dir: string;
let out: string;

const options = (extra: Partial<FeedOptions> = {}): FeedOptions => ({
  dir,
  channel: "stable",
  tag: "v0.1.0",
  repo: FEED_REPO,
  out,
  now: NOW,
  ...extra,
});
const place = (installer = `pap-install-${ID}.sh`, archive = `pap-${ID}-linux-x64.tar.gz`) => {
  writeFileSync(join(dir, installer), INSTALLER);
  writeFileSync(join(dir, archive), ARCHIVE);
};
const readJson = (name: string) => JSON.parse(readFileSync(join(out, name), "utf8")) as unknown;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-release-feed-"));
  dir = join(root, "archive");
  out = join(root, "out");
  mkdirSync(dir);
  mkdirSync(out);
  place();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("generateFeed", () => {
  it("writes a feed that FeedSchema accepts, with the release id in both names", () => {
    generateFeed(options());
    const feed = FeedSchema.parse(readJson("pap-feed-stable.json"));
    expect(feed).toMatchObject({
      format: 1,
      channel: "stable",
      version: "0.1.0",
      releaseId: ID,
      publishedAt: "2026-10-17T12:00:00.000Z",
      minNode: "24.14",
      notes: `https://github.com/${FEED_REPO}/releases/tag/v0.1.0`,
    });
    expect(feed.installer.name).toBe(`pap-install-${ID}.sh`);
    expect(feed.archive.name).toBe(`pap-${ID}-linux-x64.tar.gz`);
    expect(FEED_HOSTS.has(new URL(feed.archive.url).hostname)).toBe(true);
    expect(feed.archive.url).toBe(
      `https://github.com/${FEED_REPO}/releases/download/v0.1.0/pap-${ID}-linux-x64.tar.gz`,
    );
  });

  it("takes the installer sha256 and both sizes from the files", () => {
    generateFeed(options());
    const feed = FeedSchema.parse(readJson("pap-feed-stable.json"));
    expect(feed.installer.sha256).toBe(sha(INSTALLER));
    expect(feed.installer.size).toBe(Buffer.byteLength(INSTALLER));
    expect(feed.archive.size).toBe(3);
  });

  it("writes an env file of exactly seven lines in order, each KEY=value with no quotes or spaces", () => {
    generateFeed(options());
    const text = readFileSync(join(out, "pap-feed-stable.env"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.slice(0, -1).split("\n");
    expect(lines.map((line) => line.split("=")[0])).toEqual([
      "VERSION",
      "RELEASE_ID",
      "INSTALLER_NAME",
      "INSTALLER_URL",
      "INSTALLER_SHA256",
      "ARCHIVE_NAME",
      "ARCHIVE_URL",
    ]);
    for (const line of lines) expect(line).toMatch(/^[A-Z][A-Z0-9_]*=[A-Za-z0-9._:/@+-]+$/);
    expect(lines[4]).toBe(`INSTALLER_SHA256=${sha(INSTALLER)}`);
  });

  it("matches the committed fixture T15 shares", () => {
    generateFeed(options());
    expect(readFileSync(join(out, "pap-feed-stable.env"), "utf8")).toBe(readFileSync(FIXTURE_ENV, "utf8"));
  });

  it("refuses an installer or archive whose name does not match the release id", () => {
    rmSync(join(dir, `pap-${ID}-linux-x64.tar.gz`));
    writeFileSync(join(dir, "pap-0.2.0-zzz-linux-x64.tar.gz"), ARCHIVE);
    expect(() => generateFeed(options())).toThrow(/archive name does not match the release id/);
    expect(existsSync(join(out, "pap-feed-stable.json"))).toBe(false);
    expect(existsSync(join(out, "pap-feed-stable.env"))).toBe(false);
  });

  it("refuses a missing installer, a missing archive and a second candidate", () => {
    rmSync(join(dir, `pap-install-${ID}.sh`));
    expect(() => generateFeed(options())).toThrow(/installer/);
    place();
    rmSync(join(dir, `pap-${ID}-linux-x64.tar.gz`));
    expect(() => generateFeed(options())).toThrow(/archive/);
    place();
    writeFileSync(join(dir, "pap-other-linux-x64.tar.gz"), ARCHIVE);
    expect(() => generateFeed(options())).toThrow(/exactly one/);
  });

  it("refuses a repo with a space or .. and a repo the feed schema does not accept", () => {
    expect(() => generateFeed(options({ repo: "Some One/repo" }))).toThrow(/repo/);
    expect(() => generateFeed(options({ repo: "../repo" }))).toThrow(/repo/);
    expect(() => generateFeed(options({ repo: "a/..b" }))).toThrow(/repo/);
    expect(() => generateFeed(options({ repo: "Other/repo" }))).toThrow(/not an https release URL/);
    expect(existsSync(join(out, "pap-feed-stable.json"))).toBe(false);
  });

  it("refuses a tag that does not belong to the channel", () => {
    expect(() => generateFeed(options({ tag: "next" }))).toThrow(/tag/);
    expect(() => generateFeed(options({ tag: "v1.2" }))).toThrow(/tag/);
    expect(() =>
      generateFeed(options({ channel: "next", tag: "v0.1.0", core: "0.1.0", runNumber: 1 })),
    ).toThrow(/tag/);
  });

  it("gives the next channel a -next.<run> version, the tag next and the archive id", () => {
    generateFeed(options({ channel: "next", tag: "next", core: "0.2.0", runNumber: 12 }));
    const feed = FeedSchema.parse(readJson("pap-feed-next.json"));
    expect(feed.version).toBe("0.2.0-next.12");
    expect(feed.releaseId).toBe(ID);
    expect(feed.archive.url).toContain("/releases/download/next/");
    expect(readFileSync(join(out, "pap-feed-next.env"), "utf8")).toContain("VERSION=0.2.0-next.12\n");
  });

  it("refuses a next feed without a core version and a run number", () => {
    expect(() => generateFeed(options({ channel: "next", tag: "next" }))).toThrow(/core/);
    expect(() => generateFeed(options({ channel: "next", tag: "next", core: "0.2.0" }))).toThrow(
      /run number/,
    );
  });

  it("writes with wx: an existing file is refused unless force is given", () => {
    generateFeed(options());
    const before = readFileSync(join(out, "pap-feed-stable.json"), "utf8");
    expect(() => generateFeed(options({ now: new Date("2026-10-18T00:00:00.000Z") }))).toThrow(/exists/);
    expect(readFileSync(join(out, "pap-feed-stable.json"), "utf8")).toBe(before);
    generateFeed(options({ now: new Date("2026-10-18T00:00:00.000Z"), force: true }));
    expect(readFileSync(join(out, "pap-feed-stable.json"), "utf8")).toContain("2026-10-18");
  });

  it("refuses when only one of the two output files exists, before writing the other", () => {
    writeFileSync(join(out, "pap-feed-stable.env"), "x\n");
    expect(() => generateFeed(options())).toThrow(/exists/);
    expect(existsSync(join(out, "pap-feed-stable.json"))).toBe(false);
  });
});
