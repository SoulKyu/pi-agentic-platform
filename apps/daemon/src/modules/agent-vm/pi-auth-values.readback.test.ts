import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Mutant (run for real in the T15b fix report): M-readback -- the `credential === undefined` guard removed -> this case
 * resolves with no value for a provider Pi listed, instead of rejecting.
 */
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  readStoredCredential: () => undefined,
}));

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pap-t15b-readback-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a provider Pi lists and cannot read back", () => {
  it("is an error, never a skip", async () => {
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ a: { type: "api_key", key: `sk-test-${"A".repeat(24)}` } }),
    );
    const { readPiAuth } = await import("./pi-auth-values.ts");
    await expect(readPiAuth(dir)).rejects.toThrow("a credential cannot be read back");
    expect(expect.getState().currentTestName).toBeDefined();
  });
});
