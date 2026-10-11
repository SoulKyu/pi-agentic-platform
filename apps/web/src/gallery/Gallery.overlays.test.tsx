// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
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
});
