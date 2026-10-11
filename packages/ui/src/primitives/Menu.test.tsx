// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mountWithTooltips } from "../testing/dom.ts";
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
});
