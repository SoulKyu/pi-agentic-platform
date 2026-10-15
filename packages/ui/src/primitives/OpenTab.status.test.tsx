// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mountWithTooltips } from "../testing/dom.ts";
import { OpenTab } from "./OpenTab.tsx";

const tab = (status: "running" | "waiting" | "done" | "review" | null, statusLabel?: string) => (
  <OpenTab
    tabId="t"
    title="feat/x"
    active={false}
    status={status}
    {...(statusLabel ? { statusLabel } : {})}
    closeLabel="Close"
    onSelect={() => {}}
    onClose={() => {}}
  />
);

describe("OpenTab status", () => {
  it.each([
    ["running", "bg-agent-fill"],
    ["waiting", "bg-attn-fill"],
    ["done", "bg-ok"],
    ["review", "bg-you-fill"],
  ] as const)("%s draws a %s dot, hidden from assistive tech, and says the word", async (status, tone) => {
    const page = await mountWithTooltips(tab(status, "Word"));
    const dot = page.container.querySelector('[role="tab"] > [aria-hidden]') as HTMLElement;
    expect(dot.className).toContain(tone);
    expect(page.container.querySelector('[role="tab"] .sr-only')?.textContent).toBe("Word");
    // the accessible name reads two words, not one run-together token
    expect(page.container.querySelector('[role="tab"]')?.textContent).toBe("feat/x Word");
    await page.unmount();
  });

  it("no status draws neither the dot nor the word", async () => {
    const page = await mountWithTooltips(tab(null, "Word"));
    expect(page.container.querySelector('[role="tab"] [aria-hidden]')).toBeNull();
    expect(page.container.querySelector('[role="tab"] .sr-only')).toBeNull();
    await page.unmount();
  });
});
