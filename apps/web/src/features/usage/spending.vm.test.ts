import { describe, expect, it } from "vitest";
import {
  billingLabelKey,
  formatTokens,
  formatUsd,
  meterFraction,
  originLabelKey,
  orderedOrigins,
  SPENDING_RANGES,
} from "./spending.vm.ts";

describe("spending view-model", () => {
  it("offers today, 7 days and 30 days, in that order", () => {
    expect(SPENDING_RANGES).toEqual(["today", "7d", "30d"]);
  });

  it("labels a subscription's cost API-equivalent and nothing else", () => {
    expect(billingLabelKey("subscription")).toBe("settingsAutomation.billing.subscription");
    expect(billingLabelKey("api")).toBeNull();
    expect(billingLabelKey("unknown")).toBeNull();
  });

  it("fills the cost meter with spent over budget, capped at 1", () => {
    expect(meterFraction(0, 5)).toBe(0);
    expect(meterFraction(1.25, 5)).toBe(0.25);
    expect(meterFraction(5, 5)).toBe(1);
    expect(meterFraction(12, 5)).toBe(1);
  });

  it("hides the budget meter without a budget, and shows a budget of 0 as full", () => {
    expect(meterFraction(3, null)).toBeNull();
    expect(meterFraction(0, 0)).toBe(1);
    expect(meterFraction(2, 0)).toBe(1);
  });

  it("formats money in the owner's locale without hiding small spend", () => {
    expect(formatUsd(1.5, "en")).toBe("$1.50");
    expect(formatUsd(0.004, "en")).toBe("$0.004");
    expect(formatUsd(0.00004, "en")).toBe("<$0.0001");
    expect(formatUsd(0, "en")).toBe("$0.00");
    expect(formatUsd(1.5, "fr").replace(/[\u202f\u00a0]/g, " ")).toBe("1,50 $US");
    expect(formatUsd(Number.NaN, "en")).toBe("$0.00");
  });

  it("formats token counts with the locale's grouping", () => {
    expect(formatTokens(1234567, "en")).toBe("1,234,567");
    expect(formatTokens(1234567, "fr").replace(/[\u202f\u00a0]/g, " ")).toBe("1 234 567");
  });

  it("names the four origins and leaves an unknown one to be shown as it is", () => {
    expect(originLabelKey("user")).toBe("settingsAutomation.origin.user");
    expect(originLabelKey("trigger")).toBe("settingsAutomation.origin.trigger");
    expect(originLabelKey("resume")).toBe("settingsAutomation.origin.resume");
    expect(originLabelKey("extension")).toBe("settingsAutomation.origin.extension");
    expect(originLabelKey("future")).toBeNull();
  });

  it("orders the origins you, triggers, resumes, extensions, then the others by name", () => {
    const row = (origin: string) => ({ origin, costUsd: 1, tokens: 1, runs: 1 });
    expect(
      orderedOrigins(["zeta", "resume", "user", "alpha", "extension", "trigger"].map(row)).map(
        (r) => r.origin,
      ),
    ).toEqual(["user", "trigger", "resume", "extension", "alpha", "zeta"]);
  });
});
