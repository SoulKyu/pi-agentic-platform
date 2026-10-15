// @vitest-environment happy-dom
import type { UsageSummary } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { button, click, mount, text } from "../../testing/dom.ts";
import "./register-automation-settings-catalog.ts";
import { SpendingPanel } from "./SpendingPanel.tsx";

afterEach(() => setLocale("en"));

const SUMMARY: UsageSummary = {
  from: 1,
  to: 2,
  timeZone: "UTC",
  totals: { costUsd: 12.5, tokens: 1_234_567, runs: 9 },
  byOrigin: [
    { origin: "resume", costUsd: 0.5, tokens: 10, runs: 1 },
    { origin: "user", costUsd: 10, tokens: 1_000_000, runs: 5 },
    { origin: "trigger", costUsd: 2, tokens: 234_557, runs: 3 },
  ],
  byModel: [
    { provider: "anthropic", model: "sonnet", billing: "subscription", costUsd: 9, tokens: 900_000, runs: 4 },
    { provider: "openai", model: "gpt-x", billing: "api", costUsd: 3.5, tokens: 334_567, runs: 5 },
  ],
  metrics: false,
  otlpHost: null,
};

const spendOf = (todayUsd: number, budgetUsd: number | null) => ({ spend: { todayUsd, budgetUsd } });
function panel(patch: Partial<Parameters<typeof SpendingPanel>[0]> = {}) {
  return mount(
    <SpendingPanel
      summary={SUMMARY}
      failed={false}
      range="today"
      onRange={() => {}}
      spend={{ todayUsd: 2.5, budgetUsd: 5 }}
      quotasLink={<a href="/settings/models">Settings › Models</a>}
      {...patch}
    />,
  );
}
const rows = (container: HTMLElement, table: string) =>
  [...container.querySelectorAll(`[data-table="${table}"] tbody tr`)].map((row) =>
    [...row.querySelectorAll("td, th")].map((cell) => cell.textContent),
  );

describe("SpendingPanel", () => {
  it("fills the cost meter with today's automatic spend over the budget and says what it counts", async () => {
    const page = await panel();
    const meter = page.container.querySelector('[role="meter"]') as HTMLElement;
    expect(meter.getAttribute("aria-label")).toBe("Automatic runs today");
    expect(meter.getAttribute("aria-valuenow")).toBe("0.5");
    expect(meter.getAttribute("aria-valuetext")).toBe("$2.50 of $5.00");
    expect(text(page.container)).toContain(
      "Counts triggers and automatic resumes, the ones in progress too. Sessions you start, and a click on Resume now, are not counted.",
    );
  });

  it("hides the budget meter when there is no budget, and still shows the spend", async () => {
    const page = await panel(spendOf(2.5, null));
    expect(page.container.querySelector('[role="meter"]')).toBeNull();
    expect(text(page.container)).toContain("$2.50, no budget");
  });

  it("shows no meter before the usage stream has answered", async () => {
    const page = await panel({ spend: null });
    expect(page.container.querySelector('[role="meter"]')).toBeNull();
    expect(text(page.container)).not.toContain("no budget");
  });

  it("shows a spent budget of 0 as full", async () => {
    const page = await panel(spendOf(0, 0));
    expect(
      (page.container.querySelector('[role="meter"]') as HTMLElement).getAttribute("aria-valuenow"),
    ).toBe("1");
  });

  it("does not round a small spend to nothing", async () => {
    const page = await panel(spendOf(0.004, 5));
    expect(text(page.container)).toContain("$0.004 of $5.00");
  });

  it("totals everything the owner ran in the range, labelled as such", async () => {
    const page = await panel({ range: "7d" });
    expect(text(page.container)).toContain("Everything you ran, 7 days");
    expect(text(page.container)).toContain("$12.50 · 1,234,567 tokens · 9 runs");
    expect(text(page.container)).toContain("The sessions you started yourself are included here.");
  });

  it("lists provider and model with tokens, runs and cost, a subscription's cost as API-equivalent", async () => {
    const page = await panel();
    expect(rows(page.container, "models")).toEqual([
      ["anthropic / sonnet", "900,000", "4", "$9.00 API-equivalent"],
      ["openai / gpt-x", "334,567", "5", "$3.50"],
    ]);
  });

  it("totals by origin: you, triggers, resumes", async () => {
    const page = await panel();
    expect(rows(page.container, "origins").map((row) => [row[0], row[3]])).toEqual([
      ["You", "$10.00"],
      ["Triggers", "$2.00"],
      ["Resumes", "$0.50"],
    ]);
  });

  it("asks for another range through the segmented control", async () => {
    const onRange = vi.fn();
    const page = await panel({ onRange });
    await click(button(page.container, "30 days"));
    expect(onRange).toHaveBeenCalledWith("30d");
  });

  it("links to the provider quotas instead of repeating them", async () => {
    const page = await panel();
    expect(page.container.querySelector('a[href="/settings/models"]')?.textContent).toBe("Settings › Models");
    expect(text(page.container)).toContain("Provider quotas are shown in");
  });

  it("says nothing ran, and that the spending could not be read", async () => {
    const empty = await panel({
      summary: { ...SUMMARY, byModel: [], byOrigin: [], totals: { costUsd: 0, tokens: 0, runs: 0 } },
    });
    expect(text(empty.container)).toContain("Nothing ran in this period.");
    const failed = await panel({ summary: null, failed: true });
    expect(failed.container.querySelector('[role="alert"]')?.textContent).toBe(
      "The spending could not be read.",
    );
  });

  it("formats money in the locale", async () => {
    setLocale("fr");
    const page = await panel();
    expect(text(page.container).replace(/[\u202f\u00a0]/g, " ")).toContain("2,50 $US sur 5,00 $US");
  });
});
