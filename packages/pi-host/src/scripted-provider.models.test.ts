import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildScriptedProvider, ProviderScript, scriptedReplies } from "./scripted-provider.ts";

describe("a script with several models (M7 Task 7, tests only)", () => {
  it("lists the main model first, then the extra ones, with their reasoning flag", () => {
    const script = ProviderScript.parse({
      modelId: "plain",
      steps: [{ text: "hi" }],
      extraModels: [{ id: "thinker", reasoning: true }, { id: "other" }],
    });
    const { provider, model } = buildScriptedProvider(script);
    expect(model.id).toBe("plain");
    expect(provider.getModels().map((m) => [m.id, m.reasoning])).toEqual([
      ["plain", false],
      ["thinker", true],
      ["other", false],
    ]);
  });

  it("flags the main model as reasoning when the script says so", () => {
    const { model } = buildScriptedProvider(
      ProviderScript.parse({ reasoning: true, steps: [{ text: "hi" }] }),
    );
    expect(model.reasoning).toBe(true);
  });

  it("refuses a duplicate model id and an empty extra id", () => {
    expect(
      ProviderScript.safeParse({ modelId: "a", steps: [{ text: "x" }], extraModels: [{ id: "a" }] }).success,
    ).toBe(false);
    expect(ProviderScript.safeParse({ steps: [{ text: "x" }], extraModels: [{ id: "" }] }).success).toBe(
      false,
    );
  });
});

describe("the thinking level of each request", () => {
  it("is appended to the capture file with the model that served it, `off` when none was asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-thinking-"));
    try {
      const file = join(dir, "thinking.jsonl");
      const reply = scriptedReplies(
        ProviderScript.parse({ captureThinking: file, steps: [{ text: "one" }, { text: "two" }] }),
      );
      const call = { messages: [{ role: "user", content: "a" }] };
      reply(call, undefined, undefined, { id: "plain" });
      reply(call, { reasoning: "high" }, undefined, { id: "thinker" });
      expect(readFileSync(file, "utf8")).toBe(
        `${JSON.stringify({ model: "plain", thinking: "off" })}\n${JSON.stringify({ model: "thinker", thinking: "high" })}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not captured unless the script asks for it", () => {
    const reply = scriptedReplies(ProviderScript.parse({ steps: [{ text: "one" }] }));
    expect(() => reply({ messages: [] }, { reasoning: "low" }, undefined, { id: "x" })).not.toThrow();
  });
});
