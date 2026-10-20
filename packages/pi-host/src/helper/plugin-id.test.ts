import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginIdKey } from "./plugin-id.ts";

/*
 * Mutants (S2 m1), run for real: the key removed after a read that saw nothing ("never removes a key a concurrent creator
 * linked": the missing case); the bad file removed without checking it is still the one that was read (the replaced case).
 */
let root: string;
const file = () => join(root, "secrets", "plugin-id.key");
const WINNER = Buffer.alloc(32, 7);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-plugin-id-"));
  mkdirSync(join(root, "secrets"), { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const plantWinner = (): void => {
  const temp = `${file()}.winner`;
  writeFileSync(temp, WINNER, { mode: 0o600 });
  rmSync(file(), { force: true });
  writeFileSync(file(), readFileSync(temp), { mode: 0o600 });
  rmSync(temp);
};

describe("pluginIdKey", () => {
  it("makes the key once, 32 bytes, 0600, and returns the same one after", () => {
    const first = pluginIdKey(root);
    expect(first).toHaveLength(32);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(pluginIdKey(root).equals(first)).toBe(true);
  });

  it("never removes a key a concurrent creator linked after this one saw none: it reads the winner", () => {
    const key = pluginIdKey(root, { afterRead: plantWinner });
    expect(key.equals(WINNER)).toBe(true);
    expect(readFileSync(file()).equals(WINNER)).toBe(true);
  });

  it("does not remove a damaged file that was replaced by a good key meanwhile", () => {
    writeFileSync(file(), "short", { mode: 0o600 });
    const key = pluginIdKey(root, { afterRead: plantWinner });
    expect(key.equals(WINNER)).toBe(true);
    expect(readFileSync(file()).equals(WINNER)).toBe(true);
  });

  it.each([
    ["a wrong size", () => writeFileSync(file(), "short", { mode: 0o600 })],
    ["readable by others", () => writeFileSync(file(), Buffer.alloc(32, 1), { mode: 0o644 })],
    ["a link", () => symlinkSync(join(root, "elsewhere"), file())],
  ])("replaces a key that is %s", (_label, plant) => {
    plant();
    if (_label === "readable by others") chmodSync(file(), 0o644);
    const key = pluginIdKey(root);
    expect(key).toHaveLength(32);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readFileSync(file()).equals(key)).toBe(true);
  });
});
