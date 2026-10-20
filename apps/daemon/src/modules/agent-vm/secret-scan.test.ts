import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROFILE_SECRET_NOTICE,
  ProfileSecretError,
  SCAN_CHUNK_BYTES,
  scanTree,
  walkTree,
} from "./secret-scan.ts";
import { type Scratch, scratch } from "./testing/profile-fixture.ts";

const VALUE = "s3cret-value-123";
let s: Scratch;
afterEach(() => s?.cleanup());

function refused(secrets: string[]): ProfileSecretError | null {
  try {
    scanTree(s.out, secrets);
    return null;
  } catch (error) {
    return error instanceof ProfileSecretError ? error : (error as never);
  }
}

describe("scanTree", () => {
  it("names the file, never the value, and carries the notice", () => {
    s = scratch();
    s.put("build/pi-agent/pkg/a.js", `x = "${VALUE}"`);
    const error = refused([VALUE]);
    expect(error?.file).toBe("pkg/a.js");
    expect(error?.message).toContain(PROFILE_SECRET_NOTICE);
    expect(error?.message).toContain("pkg/a.js");
    expect(error?.message).not.toContain(VALUE);
    expect(PROFILE_SECRET_NOTICE).toBe(
      "Un fichier du profil Pi contient un secret ; il n'entre pas dans l'image.",
    );
  });

  // Mutant "a scan that skips small files": a file that is only the 8-character value must still be refused.
  it("refuses a tiny file that is exactly an 8-character secret", () => {
    s = scratch();
    s.put("build/pi-agent/tiny", "12345678");
    expect(refused(["12345678"])?.file).toBe("tiny");
  });

  it("ignores a value of 7 characters (the redactor's rule) and an empty list", () => {
    s = scratch();
    s.put("build/pi-agent/a", "1234567 and abc");
    expect(refused(["1234567", ""])).toBeNull();
    expect(refused([])).toBeNull();
  });

  // Mutant "no carry-over between chunks": the value straddles the chunk boundary.
  it("finds a value that straddles a read chunk", () => {
    s = scratch();
    const buffer = Buffer.alloc(SCAN_CHUNK_BYTES * 2, 0x61);
    buffer.write(VALUE, SCAN_CHUNK_BYTES - 5);
    mkdirSync(s.out, { recursive: true });
    writeFileSync(join(s.out, "big.bin"), buffer);
    expect(refused([VALUE])?.file).toBe("big.bin");
  });

  it("finds the JSON-escaped form of a value", () => {
    s = scratch();
    s.put("build/pi-agent/c.json", JSON.stringify({ k: 'quote"inside-value' }));
    expect(refused(['quote"inside-value'])?.file).toBe("c.json");
  });

  it("scans a link's target text and withholds a file name that holds a secret", () => {
    s = scratch();
    mkdirSync(s.out, { recursive: true });
    symlinkSync(`../${VALUE}`, join(s.out, "link"));
    expect(refused([VALUE])?.file).toBe("link");
    s.cleanup();
    s = scratch();
    s.put(`build/pi-agent/${VALUE}.txt`, "x");
    const error = refused([VALUE]);
    expect(error?.file).toBe("[name withheld]");
    expect(error?.message).not.toContain(VALUE);
  });

  it("walkTree lists files, links and folders in a stable order", () => {
    s = scratch();
    s.put("build/pi-agent/b/x", "1");
    s.put("build/pi-agent/a", "2");
    symlinkSync("a", join(s.out, "l"));
    expect(walkTree(s.out).map((entry) => `${entry.kind}:${entry.rel}`)).toEqual([
      "file:a",
      "dir:b",
      "file:b/x",
      "link:l",
    ]);
  });
});
