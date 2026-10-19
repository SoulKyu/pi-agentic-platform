import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTreeSafely } from "./safe-tree.ts";

/*
 * Mutants (RT-43) killed here, run for real:
 *  - M-unbounded: no byte budget while reading: "a file a concurrent writer keeps growing" copies 5,610 bytes, not stops.
 *  - M-open-follow: O_NOFOLLOW dropped from an entry's open: "a file swapped for a link after the look" copies the
 *    outside secret ("a link outside" is never followed, even when it appears after the lstat).
 */
const hooks = vi.hoisted(() => ({
  afterRead: null as null | (() => void),
  afterLstat: null as null | ((where: string) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: null,
    ) => {
      const n = actual.readSync(fd, buffer, offset, length, position);
      hooks.afterRead?.();
      return n;
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const result = actual.lstatSync(...args);
      hooks.afterLstat?.(String(args[0]));
      return result;
    },
  };
});

const uid = process.getuid?.() ?? -1;
let work: string;
let source: string;
let target: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "vmd-safe-race-"));
  source = path.join(work, "source");
  target = path.join(work, "target");
  mkdirSync(source);
});
afterEach(() => {
  hooks.afterRead = null;
  hooks.afterLstat = null;
  rmSync(work, { recursive: true, force: true });
});

describe("copyTreeSafely against a writer that changes the source while it is read (RT-13)", () => {
  it("a file a concurrent writer keeps growing never copies past the cap (copyFileSync copied 5,010 bytes against 1,000)", () => {
    const victim = path.join(source, "grows");
    writeFileSync(victim, Buffer.alloc(600, 1));
    let grown = 0;
    hooks.afterRead = () => {
      if (grown >= 5010) return;
      grown += 1000;
      appendFileSync(victim, Buffer.alloc(1000, 2));
    };
    expect(copyTreeSafely(source, target, uid, { maxBytes: 1000, maxEntries: 10 })).toBe("too_large");
    expect(grown).toBeGreaterThan(0);
    expect(existsSync(target)).toBe(false);
  });

  it("a file swapped for a link to an outside secret after the look answers `changed`, the secret is never copied", () => {
    const secret = path.join(work, "secret");
    writeFileSync(secret, "s3cret");
    const victim = path.join(source, "victim");
    writeFileSync(victim, "innocent");
    let swapped = false;
    hooks.afterLstat = (where) => {
      if (swapped || !where.endsWith("/victim")) return;
      swapped = true;
      unlinkSync(victim);
      symlinkSync(secret, victim);
    };
    expect(copyTreeSafely(source, target, uid, { maxBytes: 1000, maxEntries: 10 })).toBe("changed");
    expect(swapped).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("a folder swapped for a link to an outside folder after the look answers `changed`", () => {
    const outside = path.join(work, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret"), "s3cret");
    const victim = path.join(source, "victim");
    mkdirSync(victim);
    let swapped = false;
    hooks.afterLstat = (where) => {
      if (swapped || !where.endsWith("/victim")) return;
      swapped = true;
      rmSync(victim, { recursive: true });
      symlinkSync(outside, victim);
    };
    expect(copyTreeSafely(source, target, uid, { maxBytes: 1000, maxEntries: 10 })).toBe("changed");
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(outside)).toEqual(["secret"]);
  });

  it("an entry that vanishes between the look and the open answers `changed`, never a crash", () => {
    const vanish = path.join(source, "gone");
    writeFileSync(vanish, "x");
    let removed = false;
    hooks.afterLstat = (where) => {
      if (removed || !where.endsWith("/gone")) return;
      removed = true;
      unlinkSync(vanish);
    };
    expect(copyTreeSafely(source, target, uid, { maxBytes: 1000, maxEntries: 10 })).toBe("changed");
    expect(existsSync(target)).toBe(false);
  });
});
