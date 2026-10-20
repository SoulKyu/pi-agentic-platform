import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readVersion, VMD_VERSION } from "./version.ts";

const packageVersion = (path: string): string =>
  (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;

describe("pap-vmd's version", () => {
  // Mutant: VMD_VERSION hard-coded -> the temp package.json case fails (it reads 9.9.9, the constant cannot).
  it("is read from the package.json it is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "vmd-version-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"version":"9.9.9"}');
      expect(readVersion(join(dir, "package.json"))).toBe("9.9.9");
      writeFileSync(join(dir, "package.json"), '{"name":"x"}');
      expect(() => readVersion(join(dir, "package.json"))).toThrow(/version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Mutant: VMD_VERSION = "1.0.0" -> a copy of the module beside a 9.9.9 package.json still says 1.0.0.
  it("follows the package.json beside src/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vmd-version-"));
    try {
      mkdirSync(join(dir, "src"));
      cpSync(new URL("./version.ts", import.meta.url), join(dir, "src/version.ts"));
      writeFileSync(join(dir, "package.json"), '{"version":"9.9.9"}');
      const copy = (await import(join(dir, "src/version.ts"))) as { VMD_VERSION: string };
      expect(copy.VMD_VERSION).toBe("9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is the version of apps/vmd/package.json", () => {
    expect(VMD_VERSION).toBe(packageVersion(new URL("../package.json", import.meta.url).pathname));
  });

  // The release bumps both files together (release-please-config.json); a drift refuses every VM launch.
  it("equals the daemon's version", () => {
    expect(VMD_VERSION).toBe(packageVersion(new URL("../../daemon/package.json", import.meta.url).pathname));
  });
});
