// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount, press } from "../testing/dom.ts";
import { Gallery } from "./Gallery.tsx";

const OVERLAY_ROLES = '[role="dialog"], [role="menu"], [role="listbox"], [data-slot="dialog"]';

function opener(root: ParentNode, item: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`[data-gallery-item="${item}"] button`);
  if (!button) throw new Error(`no button in ${item}`);
  return button;
}

describe("gallery overlays", () => {
  it("leaves no dialog, menu or listbox behind while everything is closed", async () => {
    window.history.replaceState(null, "", "/dev/ui");
    const page = await mount(<Gallery />);
    expect(document.querySelectorAll(OVERLAY_ROLES)).toHaveLength(0);
    await page.unmount();
  });

  it("opens a dialog from its button and mounts it only while open", async () => {
    window.history.replaceState(null, "", "/dev/ui");
    const page = await mount(<Gallery />);
    await act(async () => opener(page.container, "Dialog").click());
    await act(async () => {});
    expect(document.querySelectorAll('[data-slot="dialog"]')).toHaveLength(1);
    const close = document.querySelector<HTMLButtonElement>('[data-slot="dialog"] [data-slot="icon-button"]');
    await act(async () => close?.click());
    expect(document.querySelectorAll(OVERLAY_ROLES)).toHaveLength(0);
    await page.unmount();
  });

  it("opens a menu from its button, and picking an item closes it", async () => {
    window.history.replaceState(null, "", "/dev/ui");
    const page = await mount(<Gallery />);
    await act(async () => opener(page.container, "Menu").click());
    await act(async () => {});
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.length).toBeGreaterThan(0);
    await act(async () => (items[0] as HTMLElement).click());
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
    await page.unmount();
  });

  it("unmounts the menu when Escape closes it, so the next press mounts a fresh one", async () => {
    window.history.replaceState(null, "", "/dev/ui");
    const page = await mount(<Gallery />);
    await act(async () => opener(page.container, "Menu").click());
    await act(async () => {});
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    await press(document.activeElement ?? document.body, { key: "Escape" });
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
    expect(opener(page.container, "Menu").getAttribute("aria-haspopup")).toBeNull();
    await page.unmount();
  });

  it("gallery-picker-in-dialog: the 2000-model picker opens from its dialog, modal and portalled to the body, on a scrolling list", async () => {
    window.history.replaceState(null, "", "/dev/ui");
    const page = await mount(<Gallery />);
    const figure = page.container.querySelector('[data-testid="gallery-picker-in-dialog"]');
    await act(async () => figure?.querySelector("button")?.click());
    await act(async () => {});
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const field = dialog.querySelector('button[aria-haspopup="dialog"]') as HTMLElement;
    await act(async () => field.click());
    await vi.waitFor(
      async () => {
        await act(async () => {});
        expect(document.querySelectorAll('[role="option"]').length).toBe(2000);
      },
      { timeout: 10_000 },
    );
    expect(dialog.contains(document.querySelector('[data-slot="popover"]'))).toBe(false);
    const list = document.querySelector('[role="listbox"]') as HTMLElement;
    expect(list.classList.contains("overflow-y-auto")).toBe(true);
    await page.unmount();
  });
});
