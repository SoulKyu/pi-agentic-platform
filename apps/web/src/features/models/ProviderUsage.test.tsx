// @vitest-environment happy-dom
import type { ModelsUsageResult } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { current, newBed, overviewOf, PROVIDERS, providerButton, show } from "./models-bed.tsx";
import { ProviderUsage } from "./ProviderUsage.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

const RESET = 1_800_000_000;
const resetText = () =>
  new Date(RESET * 1000).toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" });
const ready: ModelsUsageResult = {
  status: "ready",
  report: {
    providerId: "openrouter",
    providerName: "OpenRouter",
    capturedAt: 1_700_000_000_000,
    buckets: [
      {
        id: "key-limit",
        label: "Key limit",
        used: 37.75,
        remaining: 12.25,
        limit: 50,
        unit: "currency",
        currency: "USD",
        period: "monthly",
      },
      {
        id: "codex:primary",
        label: "5h",
        used: 12.5,
        remaining: 87.5,
        limit: 100,
        unit: "percent",
        windowMinutes: 300,
        resetsAt: RESET,
      },
      { id: "left", label: "Requests", remaining: 40, unit: "count" },
    ],
    metrics: [
      { id: "total", label: "All-time usage", value: 120, unit: "currency", currency: "USD" },
      { id: "membership", label: "Membership", value: "<img src=x onerror=alert(1)>" },
    ],
  },
};

async function start(answer: ModelsUsageResult | (() => never)) {
  const bed = newBed();
  bed.handlers["models.usage"] = typeof answer === "function" ? answer : () => answer;
  const page = await mount(<ProviderUsage providerId="openrouter" />);
  return { bed, page };
}

describe("ProviderUsage", () => {
  it("sends nothing until the button is clicked, and then asks once for this provider", async () => {
    const { bed, page } = await start(ready);
    await settle();
    expect(bed.called("models.usage")).toEqual([]);
    expect(page.container.querySelector('[role="meter"]')).toBeNull();
    await click(button(page.container, "Check usage"));
    await settle();
    expect(bed.called("models.usage").map((call) => call.params)).toEqual([{ providerId: "openrouter" }]);
  });

  it("shows a Meter per bucket with its used and limit, the reset time, and when it was checked", async () => {
    const { page } = await start(ready);
    await click(button(page.container, "Check usage"));
    await settle();
    const meters = [...page.container.querySelectorAll('[role="meter"]')];
    expect(
      meters.map((meter) => [
        meter.getAttribute("aria-label"),
        meter.getAttribute("aria-valuenow"),
        meter.getAttribute("aria-valuemax"),
        meter.getAttribute("aria-valuetext"),
      ]),
    ).toEqual([
      ["Key limit", "37.75", "50", "37.75 / 50 USD"],
      ["5h", "12.5", "100", "12.5% used"],
    ]);
    const shown = text(page.container);
    expect(shown).toContain(`Resets ${resetText()}`);
    expect(shown).toContain("monthly");
    expect(shown).toContain("Requests");
    expect(shown).toContain("40 left");
    expect(shown).toContain("All-time usage");
    expect(shown).toContain("120 USD");
    expect(shown).toContain("Checked at");
  });

  it("renders provider text as plain text only", async () => {
    const { page } = await start(ready);
    await click(button(page.container, "Check usage"));
    await settle();
    expect(page.container.querySelector("img")).toBeNull();
    expect(text(page.container)).toContain("<img src=x onerror=alert(1)>");
  });

  it.each([
    ["auth_unavailable", "pap could not read a sign-in for this provider. Sign in, then try again."],
    ["query_failed", "The usage query failed. Try again in a minute."],
    ["unsupported", "pap cannot show usage for this provider."],
    [
      "provider_overridden",
      "An extension points this provider to another address, so pap did not send the key. Usage is not checked.",
    ],
    [
      "extensions_failed",
      "An extension failed to load, so pap did not send the key. Fix or disable it, then try again.",
    ],
  ] as const)("says %s in fixed words", async (status, words) => {
    const { page } = await start({ status });
    await click(button(page.container, "Check usage"));
    await settle();
    expect(alerts(page.container)).toEqual([words]);
    expect(page.container.querySelector('[role="meter"]')).toBeNull();
  });

  it("shows the fixed text of a failed call", async () => {
    const { page } = await start(() => {
      throw new RpcError("timeout");
    });
    await click(button(page.container, "Check usage"));
    await settle();
    expect(alerts(page.container)).toHaveLength(1);
  });

  it("does not send a second request while one is running", async () => {
    let release: (value: ModelsUsageResult) => void = () => {};
    const bed = newBed();
    bed.handlers["models.usage"] = () => new Promise<ModelsUsageResult>((resolve) => (release = resolve));
    const page = await mount(<ProviderUsage providerId="openrouter" />);
    const trigger = button(page.container, "Check usage");
    await click(trigger);
    await click(trigger);
    expect(bed.called("models.usage")).toHaveLength(1);
    expect(trigger.disabled).toBe(true);
    release(ready);
    await settle();
    expect(trigger.disabled).toBe(false);
  });

  it("renders nothing for a provider that has no usage query", async () => {
    newBed();
    const page = await mount(<ProviderUsage providerId="anthropic" />);
    expect(page.container.innerHTML).toBe("");
  });

  it("speaks French", async () => {
    setLocale("fr");
    const { page } = await start(ready);
    await click(button(page.container, "Voir la consommation"));
    await settle();
    expect(text(page.container)).toContain("Vérifié à");
    expect(text(page.container)).toContain(`Réinitialisation ${resetText()}`);
  });
});

describe("fr", () => {
  it("says an overridden provider in French", async () => {
    setLocale("fr");
    const { page } = await start({ status: "provider_overridden" });
    await click(button(page.container, "Voir la consommation"));
    await settle();
    expect(alerts(page.container)[0]).toContain("pap n'a pas envoyé la clé");
  });
});

describe("the provider detail", () => {
  it("offers Usage on a supported provider only", async () => {
    const supported = { ...PROVIDERS[1], id: "openrouter", name: "OpenRouter" } as (typeof PROVIDERS)[number];
    newBed(overviewOf({ providers: [...PROVIDERS, supported] }));
    const page = await show();
    await settle();
    await click(providerButton(page.container, "openrouter"));
    expect(hasButton(page.container, "Check usage")).toBe(true);
    await click(providerButton(page.container, "anthropic"));
    expect(hasButton(page.container, "Check usage")).toBe(false);
  });
});
