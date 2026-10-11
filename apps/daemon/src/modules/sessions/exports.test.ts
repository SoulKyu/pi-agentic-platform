import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "./testing/helpers.ts";
import { createExports, EXPORT_TTL_MS, MAX_PENDING_EXPORTS } from "./exports.ts";

const beds: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const bed of beds.splice(0)) bed.dispose();
});

const setup = (newToken?: () => string) => {
  const dir = mkdtempSync(join(tmpdir(), "pap-exports-"));
  const clock = createFakeClock();
  const logs = captureLogger();
  const exports = createExports({ dir, clock, logger: logs.logger, ...(newToken ? { newToken } : {}) });
  const touch = (path: string) => writeFileSync(path, "<html></html>");
  const bed = {
    dir,
    clock,
    logs,
    exports,
    touch,
    dispose: () => {
      exports.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  beds.push(bed);
  return bed;
};

describe("the pending exports (M2R96)", () => {
  it("makes 43 character base64url tokens and a file path of its own, under the directory", () => {
    const t = setup();
    const { token, path } = t.exports.prepare("s1", "u1");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(path.startsWith(`${t.dir}/`)).toBe(true);
    expect(path).not.toContain(token);
    expect(t.exports.prepare("s1", "u1").token).not.toBe(token);
  });

  it("creates the directory 0700 when it is missing", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pap-exports-root-")), "exports");
    const exports = createExports({ dir, clock: createFakeClock(), logger: captureLogger().logger });
    beds.push({
      dispose: () => {
        exports.stop();
        rmSync(join(dir, ".."), { recursive: true, force: true });
      },
    });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses the 17th pending export with capacity, and takes one again once a slot is free", () => {
    const t = setup();
    const first = t.exports.prepare("s1", "u1");
    for (let i = 1; i < MAX_PENDING_EXPORTS; i++) t.exports.prepare("s1", "u1");
    expect(() => t.exports.prepare("s1", "u1")).toThrow(new PapError("capacity"));
    t.exports.discard(first.token);
    expect(() => t.exports.prepare("s1", "u1")).not.toThrow();
  });

  it("gives a token once, to its own session and owner, and answers null the same way otherwise", () => {
    const t = setup();
    const { token, path } = t.exports.prepare("s1", "u1", "My chat");
    expect(t.exports.take(token, "s1", "u2")).toBeNull();
    expect(t.exports.take(token, "s2", "u1")).toBeNull();
    expect(t.exports.take("x".repeat(43), "s1", "u1")).toBeNull();
    // The failed attempts of someone else did not use the entry up.
    expect(t.exports.take(token, "s1", "u1")).toEqual({ path, title: "My chat" });
    expect(t.exports.take(token, "s1", "u1")).toBeNull();
    expect(t.clock.pending()).toBe(0);
  });

  it("answers null for a token that is not 43 base64url characters, without a lookup", () => {
    const t = setup(() => "short");
    const { token } = t.exports.prepare("s1", "u1");
    expect(t.exports.take(token, "s1", "u1")).toBeNull();
    for (const bad of ["", "a".repeat(44), `${"a".repeat(42)}/`, `${"a".repeat(42)}.`]) {
      expect(t.exports.take(bad, "s1", "u1")).toBeNull();
    }
  });

  it("deletes the file and forgets the entry when the ten minutes end", async () => {
    const t = setup();
    const { token, path } = t.exports.prepare("s1", "u1");
    t.touch(path);
    await t.clock.advance(EXPORT_TTL_MS - 1);
    expect(existsSync(path)).toBe(true);
    await t.clock.advance(1);
    expect(existsSync(path)).toBe(false);
    expect(t.exports.take(token, "s1", "u1")).toBeNull();
    expect(t.clock.pending()).toBe(0);
  });

  it("removes the file with discard, and its half-patched sibling", () => {
    const t = setup();
    const { token, path } = t.exports.prepare("s1", "u1");
    t.touch(path);
    t.touch(`${path}.patching`);
    t.exports.discard(token);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.patching`)).toBe(false);
    expect(t.clock.pending()).toBe(0);
    expect(() => t.exports.discard(token)).not.toThrow();
  });

  it("deletes only pap's own files at boot: regular <uuid>.html and <uuid>.html.patching, no folder, no link, nothing foreign", () => {
    const t = setup();
    const { path } = t.exports.prepare("s1", "u1");
    t.touch(path);
    const own = [
      "0b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html",
      "0b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html.patching",
    ];
    for (const name of own) t.touch(join(t.dir, name));
    const outside = mkdtempSync(join(tmpdir(), "pap-exports-outside-"));
    beds.push({ dispose: () => rmSync(outside, { recursive: true, force: true }) });
    writeFileSync(join(outside, "precious.html"), "mine");
    t.touch(join(t.dir, "notes.txt"));
    t.touch(join(t.dir, "stray.html"));
    t.touch(join(t.dir, "0B9C1F0E-2D3A-4C5B-8D7E-9F0A1B2C3D4E.html"));
    mkdirSync(join(t.dir, "1b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html"));
    t.touch(join(t.dir, "1b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html", "inner.html"));
    symlinkSync(join(outside, "precious.html"), join(t.dir, "2b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html"));
    symlinkSync(outside, join(t.dir, "3b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html.patching"));
    t.exports.purgeAll();
    expect(readdirSync(t.dir).sort()).toEqual([
      "0B9C1F0E-2D3A-4C5B-8D7E-9F0A1B2C3D4E.html",
      "1b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html",
      "2b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html",
      "3b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html.patching",
      "notes.txt",
      "stray.html",
    ]);
    expect(readdirSync(outside)).toEqual(["precious.html"]);
    expect(existsSync(join(t.dir, "1b9c1f0e-2d3a-4c5b-8d7e-9f0a1b2c3d4e.html", "inner.html"))).toBe(true);
    expect(t.logs.lines.filter((line) => line.msg === "export_purge_kept")).toEqual([
      expect.objectContaining({ level: "warn", count: 6 }),
    ]);
    expect(t.clock.pending()).toBe(0);
  });

  it("forgets its pending entries at purgeAll", () => {
    const t = setup();
    const { token, path } = t.exports.prepare("s1", "u1");
    t.touch(path);
    t.exports.purgeAll();
    expect(existsSync(path)).toBe(false);
    expect(t.exports.take(token, "s1", "u1")).toBeNull();
  });

  it("deletes the pending files at stop, leaves no timer and takes no more", () => {
    const t = setup();
    const { path } = t.exports.prepare("s1", "u1");
    t.touch(path);
    t.exports.stop();
    expect(existsSync(path)).toBe(false);
    expect(t.clock.pending()).toBe(0);
    expect(() => t.exports.prepare("s1", "u1")).toThrow(new PapError("capacity"));
    expect(t.clock.pending()).toBe(0);
  });

  it("logs a file it cannot delete, with a stable code and no path", async () => {
    const t = setup();
    const { path } = t.exports.prepare("s1", "u1");
    // A directory where the file should be: rm without `recursive` fails.
    mkdirSync(path);
    writeFileSync(join(path, "x"), "");
    await t.clock.advance(EXPORT_TTL_MS);
    const warned = t.logs.lines.filter((line) => line.msg === "export_delete_failed");
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0])).not.toContain(path);
  });
});
