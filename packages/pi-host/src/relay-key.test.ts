import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { applyRelayKey } from "./relay-key.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-skip-provider: stop after the first provider -> "every provider gets the key" fails.
 *  - M-env: do not set ANTHROPIC_AUTH_TOKEN -> "sets ANTHROPIC_AUTH_TOKEN" fails.
 */
const KEY = "ab".repeat(32);
const saved = process.env.ANTHROPIC_AUTH_TOKEN;
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = saved;
});

describe("applyRelayKey", () => {
  it("gives every provider the key as its runtime key (M-skip-provider)", async () => {
    const seen: Array<[string, string]> = [];
    await applyRelayKey({ setRuntimeApiKey: async (provider, key) => void seen.push([provider, key]) }, KEY, [
      "zai",
      "openai",
      "google",
    ]);
    expect(seen).toEqual([
      ["zai", KEY],
      ["openai", KEY],
      ["google", KEY],
    ]);
  });

  it("sets ANTHROPIC_AUTH_TOKEN for the bridge's claude (M-env)", async () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    await applyRelayKey({ setRuntimeApiKey: async () => {} }, KEY, []);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
  });

  it("writes no credential to a file and resolves as the provider's key on a real runtime", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "relay-key-"));
    try {
      await fs.writeFile(
        join(dir, "models.json"),
        JSON.stringify({ providers: { zai: { apiKey: "PLACEHOLDER", models: [{ id: "m" }] } } }),
      );
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
        refreshOnCreate: false,
      });
      const snapshot = async () =>
        Promise.all(
          (await fs.readdir(dir))
            .sort()
            .map(async (name) => [name, await fs.readFile(join(dir, name), "utf8")]),
        );
      const before = await snapshot();
      await applyRelayKey(runtime, KEY, ["zai"]);
      expect((await runtime.getAuth("zai"))?.auth.apiKey).toBe(KEY);
      // Pi may write its model catalog cache (`models-store.json`, no credential); the key itself is in no file.
      const after = await snapshot();
      expect(after.filter(([name]) => name !== "models-store.json")).toEqual(before);
      expect(JSON.stringify(after)).not.toContain(KEY);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
