import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRefSalt } from "./ref-salt.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pap-ref-salt-"));
  dirs.push(dir);
  return join(dir, "secrets", "vault");
};

describe("loadRefSalt (M11R104)", () => {
  it("makes 32 random bytes with mode 0600 in a 0700 folder, and leaves no temporary file", () => {
    const vault = root();
    const salt = loadRefSalt(vault);
    expect(salt).toHaveLength(32);
    expect(readFileSync(join(vault, "ref-salt")).equals(salt)).toBe(true);
    expect(statSync(join(vault, "ref-salt")).mode & 0o777).toBe(0o600);
    expect(statSync(vault).mode & 0o777).toBe(0o700);
    expect(readdirSync(vault)).toEqual(["ref-salt"]);
  });

  it("reads the same bytes on the next call and never replaces them", () => {
    const vault = root();
    const first = loadRefSalt(vault);
    expect(loadRefSalt(vault).equals(first)).toBe(true);
  });

  it("fails closed on a damaged salt: wrong length, group-readable, or a link", () => {
    const short = root();
    mkdirSync(short, { recursive: true, mode: 0o700 });
    writeFileSync(join(short, "ref-salt"), Buffer.alloc(31), { mode: 0o600 });
    expect(() => loadRefSalt(short)).toThrow("ref_salt_unreadable");

    const open = root();
    mkdirSync(open, { recursive: true, mode: 0o700 });
    writeFileSync(join(open, "ref-salt"), Buffer.alloc(32, 1), { mode: 0o600 });
    chmodSync(join(open, "ref-salt"), 0o640);
    expect(() => loadRefSalt(open)).toThrow("ref_salt_unreadable");

    const linked = root();
    mkdirSync(linked, { recursive: true, mode: 0o700 });
    writeFileSync(join(linked, "real"), Buffer.alloc(32, 2), { mode: 0o600 });
    symlinkSync(join(linked, "real"), join(linked, "ref-salt"));
    expect(() => loadRefSalt(linked)).toThrow("ref_salt_unreadable");
  });
});
