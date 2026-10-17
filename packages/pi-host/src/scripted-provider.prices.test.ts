import { describe, expect, it } from "vitest";
import { buildScriptedProvider, ProviderScript } from "./scripted-provider.ts";

const ask = { messages: [{ role: "user" as const, content: "x".repeat(400), timestamp: 1 }] };

async function reply(script: object) {
  const { provider, model } = buildScriptedProvider(ProviderScript.parse(script));
  const stream = provider.streamSimple(model, ask as never, {} as never);
  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  return { message: await stream.result(), events };
}

describe("the prices of a scripted provider (test only)", () => {
  it("reports every run as free when the script has no prices", async () => {
    const { message } = await reply({ steps: [{ text: "hello" }] });
    expect(message.usage.cost.total).toBe(0);
    expect(message.usage.input).toBeGreaterThan(0);
  });

  it("prices the estimated tokens of a reply per million: input, output and the total", async () => {
    const { message, events } = await reply({
      prices: { input: 1_000_000, output: 2_000_000 },
      steps: [{ text: "hello there" }],
    });
    const { usage } = message;
    expect(usage.cost.input).toBeCloseTo(usage.input, 10);
    expect(usage.cost.output).toBeCloseTo(usage.output * 2, 10);
    expect(usage.cost.total).toBeCloseTo(usage.input + usage.output * 2, 10);
    expect(usage.cost.total).toBeGreaterThan(0);
    expect(events.at(-1)).toBe("done");
  });

  it("refuses a negative price and an unknown key", () => {
    expect(
      ProviderScript.safeParse({ prices: { input: -1, output: 0 }, steps: [{ text: "a" }] }).success,
    ).toBe(false);
    expect(
      ProviderScript.safeParse({ prices: { input: 1, output: 0, extra: 1 }, steps: [{ text: "a" }] }).success,
    ).toBe(false);
  });
});
