import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALERT_ALLOWLIST, PINK_ALLOWLIST } from "./alert-allowlist.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const SCOPE = [""];

function sources(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      name !== "alert-allowlist.ts" &&
      !name.startsWith("testing/")
      ? [path]
      : [];
  });
}

const files = SCOPE.flatMap((folder) => sources(join(SRC, folder)))
  .filter((path) => !relative(SRC, path).startsWith("testing/"))
  .map((path) => ({
    name: relative(SRC, path),
    lines: readFileSync(path, "utf8").split("\n"),
    source: readFileSync(path, "utf8"),
  }));
const ALERT = /role=("alert"|\{[^}]*"alert")/;

describe("InlineError migration (all of apps/web/src)", () => {
  it('no role="alert" outside InlineError, Banner and the allowlist, and none on pink text', () => {
    const stray: string[] = [];
    const pink: string[] = [];
    for (const { name, lines } of files) {
      lines.forEach((line, index) => {
        if (!ALERT.test(line)) return;
        if (!(name in ALERT_ALLOWLIST)) stray.push(`${name}:${index + 1}`);
        const near = lines.slice(Math.max(0, index - 3), index + 4).join("\n");
        if (/text-attn/.test(near)) pink.push(`${name}:${index + 1}`);
      });
    }
    expect(stray).toEqual([]);
    expect(pink).toEqual([]);
  });

  it("every allowlist entry names a file that still holds an alert and gives a reason", () => {
    for (const [name, reason] of Object.entries(ALERT_ALLOWLIST)) {
      const file = files.find((one) => one.name === name);
      expect(file, name).toBeDefined();
      expect(
        file?.lines.some((line) => ALERT.test(line)),
        name,
      ).toBe(true);
      expect(reason.length, name).toBeGreaterThan(10);
    }
  });

  it("no failure is drawn as muted or status-red text by hand", () => {
    const hand: string[] = [];
    for (const { name, lines } of files) {
      lines.forEach((line, index) => {
        if (/role="status"[^>]*text-err/.test(line) || /text-err[^>]*role="status"/.test(line))
          hand.push(`${name}:${index + 1}`);
      });
    }
    expect(hand).toEqual([]);
  });

  it("no failure is drawn pink: text-attn on a live region, or InlineError tone=attn, only where the person must answer", () => {
    const pink: string[] = [];
    for (const { name, source } of files) {
      if (name in PINK_ALLOWLIST) continue;
      const line = (at: number) => source.slice(0, at).split("\n").length;
      for (const live of source.matchAll(/role=(?:"(?:status|alert)"|\{[^}]*"(?:status|alert)")/g)) {
        const at = live.index ?? 0;
        const start = source.lastIndexOf("<", at);
        const end = source.indexOf(">", at);
        if (/text-attn/.test(source.slice(start, end))) pink.push(`${name}:${line(at)} live region`);
      }
      for (const one of source.matchAll(/<InlineError\b[^>]*tone="attn"/g))
        pink.push(`${name}:${line(one.index ?? 0)} tone`);
    }
    expect(pink).toEqual([]);
  });

  it("no failure hides in pink text without a live region, or as a pink child of a status (CrashBanner, SendBar, CodemodePane, PR badges)", () => {
    const FAILURE = /failed|error|unreadable|not_found|unavailable/;
    const hidden: string[] = [];
    for (const { name, source } of files) {
      if (name in PINK_ALLOWLIST) continue;
      for (const pink of source.matchAll(/text-attn[^>]*>([^<]*)</g)) {
        if (FAILURE.test(pink[1] ?? ""))
          hidden.push(`${name}:${source.slice(0, pink.index ?? 0).split("\n").length}`);
      }
    }
    expect(hidden).toEqual([]);
  });

  it("every pink allowlist entry names a file that still draws pink, with a reason", () => {
    for (const [name, reason] of Object.entries(PINK_ALLOWLIST)) {
      const file = files.find((one) => one.name === name);
      expect(file, name).toBeDefined();
      expect(/text-attn|tone="attn"/.test(file?.source ?? ""), name).toBe(true);
      expect(reason.length, name).toBeGreaterThan(10);
    }
  });
});
