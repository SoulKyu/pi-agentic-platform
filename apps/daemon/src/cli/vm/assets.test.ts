import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSET_NAMES, bundledAssets, fetchVerified, isPlaceholder, parseAssets } from "./assets.ts";

/* Mutant: the SHA comparison in fetchVerified removed. Killed by "refuses a download whose SHA-256 differs". */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entry = (name: string, extra: object = {}) => ({
  name,
  version: "1",
  url: "https://example.invalid/x",
  sha256: "a".repeat(64),
  ...extra,
});
const file = (extra: object[] = []) => ({
  assets: [...ASSET_NAMES.map((n) => entry(n)), ...extra],
  baseImages: [],
});

describe("vm-assets.json", () => {
  it("carries T0a's pins for Kata 4.2.0 and nerdctl-full 2.4.1", () => {
    const assets = bundledAssets();
    expect(assets["kata-static"].sha256).toBe(
      "b828904fa3f1e49ddd7dc799c72cb1503cd1e772d354c3987c8d4189b2a623a8",
    );
    expect(assets["kata-tools-static"].sha256).toBe(
      "a4f8e1b6ee500b6e94d3925249e741c75bb4a89bf275b5d5066d6275c68e29ef",
    );
    expect(assets["nerdctl-full"].sha256).toBe(
      "ff018f11ac2f1354bf7b3aaaca6e0b52d81139c746a89134744d0b7be3a0e62f",
    );
    expect(isPlaceholder(assets["pap-vmd"])).toBe(true);
    for (const name of ASSET_NAMES) expect(assets[name].url.startsWith("https://")).toBe(true);
  });

  it("fails closed on a missing, duplicate, non-https or malformed entry", () => {
    expect(() => parseAssets(file())).not.toThrow();
    expect(() => parseAssets(file([entry("node")]))).toThrow(/twice/);
    expect(() => parseAssets({ assets: [], baseImages: [] })).toThrow(/lacks/);
    expect(() => parseAssets({ ...file(), assets: [entry("node", { url: "http://x" })] })).toThrow(
      /not valid/,
    );
    expect(() => parseAssets({ ...file(), assets: [entry("node", { sha256: "XYZ" })] })).toThrow(/not valid/);
    expect(() => parseAssets(null)).toThrow(/not valid/);
  });
});

describe("fetchVerified", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-vm-assets-"));
    dirs.push(dir);
    return join(dir, "a");
  };
  // sha256("abc")
  const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const asset = (sha256: string) => parseAssets(file()).node && { ...parseAssets(file()).node, sha256 };

  it("accepts the pinned bytes", async () => {
    const dest = setup();
    await fetchVerified(asset(abc), dest, (_a, d) => Promise.resolve(writeFileSync(d, "abc")));
  });

  it("refuses a download whose SHA-256 differs", async () => {
    const dest = setup();
    await expect(
      fetchVerified(asset(abc), dest, (_a, d) => Promise.resolve(writeFileSync(d, "abd"))),
    ).rejects.toThrow(/SHA-256 mismatch/);
  });

  it("never downloads a placeholder", async () => {
    let called = false;
    await expect(
      fetchVerified(asset("0".repeat(64)), setup(), () => {
        called = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(/not pinned/);
    expect(called).toBe(false);
  });
});
