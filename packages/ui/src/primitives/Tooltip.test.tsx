// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { IconSettings } from "../icons.ts";
import { mountWithTooltips } from "../testing/dom.ts";
import { IconButton } from "./IconButton.tsx";

const tooltip = () => document.querySelector('[data-slot="tooltip"]');

describe("Tooltip (loaded on first use)", () => {
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

  it("loads on the first pointer entry and renders no tooltip before it", async () => {
    const page = await mountWithTooltips(<IconButton icon={IconSettings} label="Inbox" />);
    expect(tooltip()).toBeNull();
    const button = page.container.querySelector("button") as HTMLElement;
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
      await import("./TooltipPopup.tsx");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(page.container.querySelector("button")?.getAttribute("data-state")).toBe("closed"); // Radix trigger now wraps it
    await page.unmount();
  });
});
