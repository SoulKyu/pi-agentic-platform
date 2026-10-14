import type { ModelsOverview, ProviderView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { nextStep, piSummary, STEPS } from "./setup-stepper.vm.ts";

const provider = (id: string, auth: Partial<ProviderView["auth"]>): ProviderView => ({
  id,
  name: id,
  origin: "builtin",
  auth: {
    oauthLabel: null,
    apiKey: true,
    configured: false,
    stored: null,
    status: "known",
    env: [],
    ...auth,
  },
  models: [],
  modelsTruncated: false,
});
const overview = (
  providers: ProviderView[],
  defaults: ModelsOverview["defaults"] = { provider: null, model: null, thinkingLevel: null },
) => ({ providers, defaults });

describe("setup steps", () => {
  it("run account, passkey, Pi, then end", () => {
    expect(STEPS).toEqual(["account", "passkey", "pi"]);
    expect(nextStep("account")).toBe("passkey");
    expect(nextStep("passkey")).toBe("pi");
    expect(nextStep("pi")).toBeNull();
  });
});

describe("piSummary", () => {
  it("is ready with the default model when a provider is signed in", () => {
    const summary = piSummary(
      overview([provider("openai", { configured: true })], {
        provider: "openai",
        model: "gpt-a",
        thinkingLevel: null,
      }),
    );
    expect(summary).toEqual({ kind: "ready", provider: "openai", model: "gpt-a" });
  });

  it("is ready without a default when a provider is signed in and none is chosen", () => {
    expect(piSummary(overview([provider("openai", { configured: true })]))).toEqual({
      kind: "ready",
      provider: null,
      model: null,
    });
  });

  it("counts a provider whose environment variable is set", () => {
    const env = [{ name: "ANTHROPIC_API_KEY", set: true }];
    expect(piSummary(overview([provider("anthropic", { env })])).kind).toBe("ready");
  });

  it("asks to choose when nothing is configured, or the sign-in files could not be read", () => {
    expect(piSummary(overview([provider("a", {}), provider("b", { status: "unknown" })])).kind).toBe(
      "choose",
    );
    expect(piSummary(overview([])).kind).toBe("choose");
  });
});
