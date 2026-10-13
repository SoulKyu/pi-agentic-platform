// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { IconSettings } from "../icons.ts";
import { mountWithTooltips } from "../testing/dom.ts";
import { IconButton } from "./IconButton.tsx";

const tooltip = () => document.querySelector('[data-slot="tooltip"]');

describe("Tooltip (loaded on first use)", () => {
  it("loads on the first pointer entry and opens after the provider's delay", async () => {
    const page = await mountWithTooltips(<IconButton icon={IconSettings} label="Inbox" />);
    expect(tooltip()).toBeNull();
    const button = page.container.querySelector("button") as HTMLElement;
    expect(button.getAttribute("data-state")).toBeNull(); // bare: the popup module is not loaded yet (keep this test first in the file)
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
      await import("./TooltipPopup.tsx");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const mounted = page.container.querySelector("button") as HTMLElement;
    expect(mounted.getAttribute("data-state")).toBe("closed"); // Radix trigger now wraps it
    vi.useFakeTimers();
    try {
      await act(async () => {
        mounted.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
        await vi.advanceTimersByTimeAsync(400);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(tooltip()?.textContent).toContain("Inbox");
    await page.unmount();
  });

  it("is the bare labelled button until it is hovered or focused, then shows its label and keys", async () => {
    const page = await mountWithTooltips(
      <>
        <IconButton icon={IconSettings} label="Settings" shortcut={["Ctrl", ","]} shortcutJoiner="+" />
        <button type="button">other</button>
      </>,
    );
    const first = page.container.querySelector('[data-slot="icon-button"]') as HTMLElement;
    expect(first.getAttribute("aria-label")).toBe("Settings");
    expect(tooltip()).toBeNull();
    first.focus();
    await act(async () => {
      await import("./TooltipPopup.tsx");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const mounted = page.container.querySelector('[data-slot="icon-button"]') as HTMLElement;
    expect(document.activeElement).toBe(mounted); // the re-created button keeps the focus
    expect(mounted.getAttribute("aria-label")).toBe("Settings");
    expect(tooltip()?.textContent).toContain("Settings");
    expect(tooltip()?.textContent).toContain("Ctrl");
    await page.unmount();
  });
});
