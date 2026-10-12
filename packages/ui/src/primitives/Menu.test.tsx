// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mountWithTooltips, press } from "../testing/dom.ts";
import { Menu } from "./Menu.tsx";

function stubMatchMedia(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query === "(max-width: 767.98px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function renderMenu(onSelect: () => void) {
  return mountWithTooltips(
    <Menu
      label="Session actions"
      closeLabel="Close"
      trigger={<button type="button">Actions</button>}
      items={[
        { id: "rename", label: "Rename", onSelect },
        { id: "delete", label: "Delete", tone: "danger", onSelect: () => {} },
      ]}
    />,
  );
}

describe("Menu", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is a bottom sheet of buttons on a phone; choosing an item runs it and closes the sheet", async () => {
    stubMatchMedia(true);
    const onSelect = vi.fn();
    const page = await renderMenu(onSelect);
    await click(page.container.querySelector("button") as HTMLElement);
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet?.getAttribute("data-variant")).toBe("sheet");
    const labels = [...(sheet?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Rename", "Delete"]));
    await click(
      [...(sheet?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Rename") as HTMLElement,
    );
    expect(onSelect).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await page.unmount();
  });

  it("is a Radix dropdown menu on desktop", async () => {
    stubMatchMedia(false);
    const page = await renderMenu(() => {});
    expect(page.container.querySelector("button")?.getAttribute("aria-haspopup")).toBe("menu");
    await page.unmount();
  });

  it("bounds the desktop menu to the viewport and scrolls it, so a long list stays reachable", async () => {
    stubMatchMedia(false);
    const page = await mountWithTooltips(
      <Menu
        label="Actions"
        closeLabel="Close"
        defaultOpen
        trigger={<button type="button">Actions</button>}
        items={[{ id: "one", label: "One", onSelect: () => {} }]}
      />,
    );
    const content = document.querySelector('[role="menu"]');
    expect(content?.classList.contains("max-h-app")).toBe(true);
    expect(content?.classList.contains("overflow-y-auto")).toBe(true);
    await page.unmount();
  });

  it("reports closing on desktop (Escape) and on a phone (choosing an item)", async () => {
    stubMatchMedia(false);
    const closed = vi.fn();
    const desktop = await mountWithTooltips(
      <Menu
        label="Actions"
        closeLabel="Close"
        defaultOpen
        onOpenChange={closed}
        trigger={<button type="button">Actions</button>}
        items={[{ id: "one", label: "One", onSelect: () => {} }]}
      />,
    );
    await press(document.activeElement ?? document.body, { key: "Escape" });
    expect(closed).toHaveBeenLastCalledWith(false);
    await desktop.unmount();
    stubMatchMedia(true);
    const phoneClosed = vi.fn();
    const phone = await mountWithTooltips(
      <Menu
        label="Actions"
        closeLabel="Close"
        defaultOpen
        onOpenChange={phoneClosed}
        trigger={<button type="button">Actions</button>}
        items={[{ id: "one", label: "One", onSelect: () => {} }]}
      />,
    );
    await click(
      [...document.querySelectorAll('[role="dialog"] button')].find(
        (b) => b.textContent === "One",
      ) as HTMLElement,
    );
    expect(phoneClosed).toHaveBeenLastCalledWith(false);
    await phone.unmount();
  });
});
