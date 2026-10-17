import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { craft, makeHome, NOW, PASSPHRASE, treeOf } from "../testing/restore-kit.ts";
import { restoreBackup, RestoreError, type RestoreDeps } from "./restore.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let scratch: string;
let home: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-restore-guard-"));
  home = join(scratch, "home");
  mkdirSync(join(scratch, "pi"));
  makeHome(home, ["old"], {});
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const deps = (file: string): RestoreDeps => ({
  home,
  piDir: join(scratch, "pi"),
  file,
  replace: true,
  now: NOW,
  passphrase: async () => PASSPHRASE,
});

async function refusal(file: string): Promise<string> {
  const before = treeOf(home);
  const error = await restoreBackup(deps(file)).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RestoreError);
  expect(treeOf(home)).toEqual(before);
  expect(existsSync(join(home, "pap.lock"))).toBe(false);
  return (error as Error).message;
}

describe("restore refusals added at the final review", () => {
  it("a live update/pending.json: refused, naming pap update recover, the home untouched", async () => {
    mkdirSync(join(home, "update"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "update", "pending.json"), "{}", { mode: 0o600 });
    const file = craft(scratch, "plain", { manifest: { tops: [] } });
    expect(await refusal(file)).toContain("pap update recover");
  });

  it("a plain archive that carries secrets/ (its manifest even says included) is refused", async () => {
    const file = craft(scratch, "plain-secrets", {
      files: { "secrets/vault/key": "k" },
      manifest: { secrets: "included", tops: ["secrets"] },
    });
    expect(await refusal(file)).toMatch(/not encrypted/);
  });

  it("the tar child has a timeout (a stuck tar must not hold the locks for ever)", async () => {
    const file = craft(scratch, "timeout", { manifest: { tops: [] } });
    await restoreBackup(deps(file));
    const calls = vi.mocked(childProcess.spawn).mock.calls.filter((call) => call[0] === "tar");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[2]).toMatchObject({ timeout: 3_600_000, killSignal: "SIGKILL" });
  });
});
