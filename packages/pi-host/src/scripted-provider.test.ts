import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildScriptedProvider, loadScriptedProvider, ProviderScript } from "./scripted-provider.ts";

describe("ProviderScript", () => {
  it("rejects a script without steps", () => {
    expect(ProviderScript.safeParse({ steps: [] }).success).toBe(false);
  });

  it("defaults the model id to scripted", () => {
    expect(ProviderScript.parse({ steps: [{ text: "hi" }] }).modelId).toBe("scripted");
    expect(ProviderScript.parse({ modelId: "m1", steps: [{ text: "hi" }] }).modelId).toBe("m1");
  });

  it("rejects a tool call without a name, with arguments that are not JSON, or an unknown stop reason", () => {
    expect(ProviderScript.safeParse({ steps: [{ toolCalls: [{ name: "", args: {} }] }] }).success).toBe(
      false,
    );
    expect(
      ProviderScript.safeParse({ steps: [{ toolCalls: [{ name: "bash", args: { f: () => 1 } }] }] }).success,
    ).toBe(false);
    expect(ProviderScript.safeParse({ steps: [{ stopReason: "length" }] }).success).toBe(false);
  });
});

describe("buildScriptedProvider", () => {
  it("builds a provider with exactly the scripted model on the fixed api", () => {
    const { model, provider } = buildScriptedProvider(ProviderScript.parse({ steps: [{ text: "hi" }] }));
    expect(model.id).toBe("scripted");
    expect(model.api).toBe("scripted");
    expect(provider.getModels().map((m) => m.id)).toEqual(["scripted"]);
  });

  it("names the model after the script", () => {
    const { model, provider } = buildScriptedProvider(
      ProviderScript.parse({ modelId: "quota-test", steps: [{ text: "hi" }] }),
    );
    expect(model.id).toBe("quota-test");
    expect(provider.getModels().map((m) => m.id)).toEqual(["quota-test"]);
  });
});

describe("loadScriptedProvider", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pap-script-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("reads a script file", async () => {
    const path = join(dir, "script.json");
    await writeFile(path, JSON.stringify({ modelId: "from-file", steps: [{ text: "hi" }] }));
    const { model } = await loadScriptedProvider(path);
    expect(model.id).toBe("from-file");
  });

  it("refuses a script file that is not valid", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify({ steps: [] }));
    await expect(loadScriptedProvider(path)).rejects.toThrow();
    await writeFile(path, "not json");
    await expect(loadScriptedProvider(path)).rejects.toThrow();
  });
});
