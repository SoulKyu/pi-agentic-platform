// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mountWithTooltips, press } from "../testing/dom.ts";
import { OpenTab } from "./OpenTab.tsx";

const tooltip = () => document.querySelector('[data-slot="tooltip"]');
const LONG = "x".repeat(120);

const tabOf = (title: string, onSelect = () => {}, onClose = () => {}) => (
  <OpenTab
    tabId="t"
    title={title}
    active
    closeLabel={`Close ${title}`}
    onSelect={onSelect}
    onClose={onClose}
  />
);
const settlePopup = () =>
  act(async () => {
    await import("./TooltipPopup.tsx");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("OpenTab full title (M4R89)", () => {
  it("shows a long title in a tooltip after a pointer entering the tab button", async () => {
    const page = await mountWithTooltips(tabOf(LONG));
    expect(tooltip()).toBeNull();
    const button = page.container.querySelector('[role="tab"]') as HTMLElement;
    expect(button.getAttribute("aria-label")).toBeNull();
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
      await import("./TooltipPopup.tsx");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const mounted = page.container.querySelector('[role="tab"]') as HTMLElement;
    vi.useFakeTimers();
    try {
      await act(async () => {
        mounted.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
        await vi.advanceTimersByTimeAsync(400); // the provider's delayDuration
      });
    } finally {
      vi.useRealTimers();
    }
    expect(tooltip()?.textContent).toBe(LONG);
    await page.unmount();
  });

  it("shows it on keyboard focus of the tab button too (RT-32)", async () => {
    const page = await mountWithTooltips(tabOf(LONG));
    (page.container.querySelector('[role="tab"]') as HTMLElement).focus();
    await settlePopup();
    const mounted = page.container.querySelector('[role="tab"]') as HTMLElement;
    expect(document.activeElement).toBe(mounted);
    expect(tooltip()?.textContent).toBe(LONG);
    await page.unmount();
  });

  it("keeps select and Delete-to-close working inside the tooltip", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const page = await mountWithTooltips(tabOf(LONG, onSelect, onClose));
    const button = page.container.querySelector('[role="tab"]') as HTMLElement;
    button.focus();
    await settlePopup();
    const mounted = page.container.querySelector('[role="tab"]') as HTMLElement;
    await act(async () => mounted.click());
    await press(mounted, { key: "Delete" });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("wraps from 25 characters and renders no tooltip for 24 or fewer", async () => {
    const short = await mountWithTooltips(tabOf("y".repeat(24)));
    (short.container.querySelector('[role="tab"]') as HTMLElement).focus();
    await settlePopup();
    expect(tooltip()).toBeNull();
    await short.unmount();
    const long = await mountWithTooltips(tabOf("y".repeat(25)));
    (long.container.querySelector('[role="tab"]') as HTMLElement).focus();
    await settlePopup();
    expect(tooltip()?.textContent).toBe("y".repeat(25));
    await long.unmount();
  });
});
