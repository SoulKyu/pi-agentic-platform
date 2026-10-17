// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mountWithTooltips, press, settle } from "../testing/dom.ts";
import { Popover } from "./Popover.tsx";

function stubMatchMedia(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query === "(max-width: 767.98px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function Harness({ start = false, onChange }: { readonly start?: boolean; onChange?(open: boolean): void }) {
  const [open, setOpen] = useState(start);
  return (
    <div>
      <p data-testid="sibling">Elsewhere</p>
      <Popover
        open={open}
        onOpenChange={(next) => {
          onChange?.(next);
          setOpen(next);
        }}
        label="Pick a model"
        closeLabel="Close"
        trigger={<button type="button">Model</button>}
      >
        <input aria-label="Search" />
        <p>Content</p>
      </Popover>
    </div>
  );
}

const trigger = (container: HTMLElement) => container.querySelector("button") as HTMLElement;
const content = () => document.querySelector('[data-slot="popover"]');

describe("Popover on desktop", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens and closes with its trigger", async () => {
    stubMatchMedia(false);
    const changes: boolean[] = [];
    const page = await mountWithTooltips(<Harness onChange={(open) => changes.push(open)} />);
    expect(content()).toBeNull();
    await click(trigger(page.container));
    expect(content()?.textContent).toContain("Content");
    expect(content()?.getAttribute("aria-label")).toBe("Pick a model");
    await click(trigger(page.container));
    expect(content()).toBeNull();
    expect(changes).toEqual([true, false]);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    stubMatchMedia(false);
    const page = await mountWithTooltips(<Harness />);
    await click(trigger(page.container));
    expect(content()?.contains(document.activeElement)).toBe(true);
    await press(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    expect(content()).toBeNull();
    expect(document.activeElement).toBe(trigger(page.container));
  });

  it("closes on a press outside", async () => {
    stubMatchMedia(false);
    const page = await mountWithTooltips(<Harness start />);
    await settle();
    expect(content()).not.toBeNull();
    const outside = document.querySelector("[data-testid=sibling]") as HTMLElement;
    // Radix defers a primary-button press outside until its click, so a press is a pointerdown and a click.
    await act(async () => {
      outside.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
    });
    await click(outside);
    await settle();
    expect(content()).toBeNull();
    await page.unmount();
  });

  it("is modal: the page behind it is hidden from assistive technology", async () => {
    stubMatchMedia(false);
    const page = await mountWithTooltips(<Harness start />);
    await settle();
    expect(page.container.getAttribute("aria-hidden")).toBe("true");
  });

  it("is bounded to the room the browser says it has; the panel clips and the list inside it is what scrolls", async () => {
    stubMatchMedia(false);
    await mountWithTooltips(<Harness start />);
    await settle();
    expect(content()?.classList.contains("max-h-popover")).toBe(true);
  });
});

describe("Popover on a phone", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is a bottom sheet dialog titled with its label, opened by the trigger", async () => {
    stubMatchMedia(true);
    const page = await mountWithTooltips(<Harness />);
    await click(trigger(page.container));
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet?.getAttribute("data-variant")).toBe("sheet");
    expect(sheet?.textContent).toContain("Pick a model");
    expect(sheet?.textContent).toContain("Content");
    // The sheet's body is a column that a child can shrink in, so the list is bounded by the viewport.
    expect(sheet?.querySelector(".overflow-y-auto")?.className).toContain("flex-col");
    expect(content()).toBeNull();
    await click(document.querySelector('[role="dialog"] button[aria-label="Close"]') as HTMLElement);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
