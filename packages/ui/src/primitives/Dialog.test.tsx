// @vitest-environment happy-dom
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mountWithTooltips, press, settle } from "../testing/dom.ts";
import { Dialog } from "./Dialog.tsx";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Keyboard shortcuts" closeLabel="Close">
        <input aria-label="Filter" />
      </Dialog>
    </>
  );
}

const dialog = () => document.querySelector('[role="dialog"]');

const phoneQuery = (phone: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query === "(max-width: 767.98px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

describe("Dialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens with the overlay shadow and the modal marker, and closes on Escape", async () => {
    const page = await mountWithTooltips(<Harness />);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(dialog()?.getAttribute("data-pap-modal")).not.toBeNull();
    expect(dialog()?.className).toContain("shadow-overlay");
    await press(document.activeElement ?? document.body, { key: "Escape" });
    expect(dialog()).toBeNull();
    await page.unmount();
  });

  it("does not close on the Escape that ends a Safari composition (keyCode 229)", async () => {
    const page = await mountWithTooltips(<Harness />);
    await click(page.container.querySelector("button") as HTMLElement);
    await press(document.activeElement ?? document.body, { key: "Escape", keyCode: 229 });
    expect(dialog()).not.toBeNull();
    await press(document.activeElement ?? document.body, { key: "Escape" });
    expect(dialog()).toBeNull();
    await page.unmount();
  });

  it("returns focus to the element that had it", async () => {
    const page = await mountWithTooltips(<Harness />);
    const opener = page.container.querySelector("button") as HTMLButtonElement;
    opener.focus();
    await click(opener);
    await press(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    expect(document.activeElement).toBe(opener);
    await page.unmount();
  });

  it("puts focus on the panel, not the close button, so the first Escape is not eaten by a tooltip", async () => {
    const page = await mountWithTooltips(<Harness />);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(document.activeElement).toBe(dialog());
    await page.unmount();
  });

  it("focuses the element given as initialFocus", async () => {
    const input = createRef<HTMLInputElement>();
    const page = await mountWithTooltips(
      <Dialog open onOpenChange={() => {}} title="Find" closeLabel="Close" initialFocus={input}>
        <input ref={input} aria-label="Filter" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(input.current);
    await page.unmount();
  });

  it("closes from its close button", async () => {
    const page = await mountWithTooltips(<Harness />);
    await click(page.container.querySelector("button") as HTMLElement);
    await click(document.querySelector('button[aria-label="Close"]') as HTMLElement);
    expect(dialog()).toBeNull();
    await page.unmount();
  });

  it("is a centred panel on desktop and a bottom sheet on a phone; a tap above the sheet closes it", async () => {
    phoneQuery(false);
    let page = await mountWithTooltips(<Harness />);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(dialog()?.getAttribute("data-variant")).toBe("center");
    await page.unmount();
    phoneQuery(true);
    page = await mountWithTooltips(<Harness />);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(dialog()?.getAttribute("data-variant")).toBe("sheet");
    await click(dialog() as Element);
    expect(dialog()).toBeNull();
    await page.unmount();
  });

  it("keeps drawers as drawers on a phone", async () => {
    phoneQuery(true);
    const page = await mountWithTooltips(
      <Dialog open onOpenChange={() => {}} title="Tree" closeLabel="Close" variant="drawer-left">
        <p>Body</p>
      </Dialog>,
    );
    expect(dialog()?.getAttribute("data-variant")).toBe("drawer-left");
    await page.unmount();
  });
});
