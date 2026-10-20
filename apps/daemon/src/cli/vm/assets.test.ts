import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSET_NAMES,
  RELEASE_FILLED,
  applyOverrides,
  bundledAssets,
  fetchVerified,
  isPlaceholder,
  nodeBaseImage,
  openNoFollow,
  parseAssets,
  type OpenFile,
} from "./assets.ts";

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

describe("nodeBaseImage (T15a)", () => {
  // Mutant: the digest not checked (a tag in its place reaches `image.build`'s `from`, which pap-vmd refuses).
  it("is the pinned Node image by digest, which pap-vmd accepts as a base", () => {
    expect(nodeBaseImage()).toMatch(/^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/);
  });
  it("refuses a file with no pinned node image", () => {
    expect(() => nodeBaseImage(file())).toThrow(/node base image/);
    const unpinned = { ...file(), baseImages: [{ name: "node", ref: "node:24", digest: "latest" }] };
    expect(() => nodeBaseImage(unpinned)).toThrow(/node base image/);
  });
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
    expect(assets.node.sha256).toBe("84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be");
    for (const name of ASSET_NAMES)
      expect(isPlaceholder(assets[name]), name).toBe(RELEASE_FILLED.includes(name));
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

/* Mutants: the owner check removed ("not owned by root"); a Kata override accepted ("overrides kata-static"). */
describe("--assets overrides (AVM-E35)", () => {
  const compiled = parseAssets(file());
  const text = (changed: Record<string, object> = {}) =>
    JSON.stringify({ assets: ASSET_NAMES.map((n) => ({ ...compiled[n], ...changed[n] })), baseImages: [] });
  const open =
    (over: Partial<ReturnType<OpenFile>> = {}): OpenFile =>
    () => ({
      isFile: true,
      uid: 0,
      mode: 0o100644,
      text: text(),
      ...over,
    });

  it("refuses a file owned by a user, writable by group or others, or not regular", () => {
    expect(() => applyOverrides(compiled, "/f", open({ uid: 1000 }))).toThrow(/not owned by root/);
    expect(() => applyOverrides(compiled, "/f", open({ mode: 0o100664 }))).toThrow(/writable by its group/);
    expect(() => applyOverrides(compiled, "/f", open({ mode: 0o100646 }))).toThrow(
      /writable by its group or others/,
    );
    expect(() => applyOverrides(compiled, "/f", open({ isFile: false }))).toThrow(/regular file/);
  });

  it("refuses a symbolic link (O_NOFOLLOW)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-vm-link-"));
    dirs.push(dir);
    writeFileSync(join(dir, "real.json"), "{}");
    symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
    expect(() => openNoFollow(join(dir, "link.json"))).toThrow(/symbolic link/);
    expect(openNoFollow(join(dir, "real.json")).isFile).toBe(true);
  });

  it("refuses an override of kata-static or any other pinned name, naming it", () => {
    for (const name of ["kata-static", "kata-tools-static", "nerdctl-full", "node"])
      expect(() =>
        applyOverrides(compiled, "/f", open({ text: text({ [name]: { sha256: "b".repeat(64) } }) })),
      ).toThrow(new RegExp(`overrides ${name}`));
  });

  it("accepts pap-vmd and the agent bundle and returns them as accepted", () => {
    const changed = { "pap-vmd": { sha256: "d".repeat(64) }, "pap-agent-bundle": { version: "2" } };
    const result = applyOverrides(compiled, "/f", open({ text: text(changed) }));
    expect(result.accepted.map((a) => a.name)).toEqual(["pap-vmd", "pap-agent-bundle"]);
    expect(result.assets["pap-vmd"].sha256).toBe("d".repeat(64));
    expect(applyOverrides(compiled, "/f", open()).accepted).toEqual([]);
  });
});
