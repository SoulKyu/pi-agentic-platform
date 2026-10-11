// @vitest-environment happy-dom
import * as ui from "@pap/ui";
import { describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { Gallery } from "./Gallery.tsx";

// Exports that are not components to show: providers, hooks, helpers, constants and types erase at runtime.
const NOT_SHOWN = new Set(["TooltipProvider", "Toaster"]);
const components = Object.entries(ui)
  .filter(
    ([name, value]) =>
      typeof value === "function" && /^[A-Z]/.test(name) && !name.startsWith("Icon") && !NOT_SHOWN.has(name),
  )
  .map(([name]) => name);

const INTERACTIVE =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [role="combobox"], [role="menuitem"]';
const COARSE_TARGET = /(?:^|\s)pointer-coarse:(?:size-11|min-h-11|h-11)(?:\s|$)/;

describe("/dev/ui gallery", () => {
  it("shows every component @pap/ui exports", async () => {
    window.history.replaceState(null, "", "/dev/ui");
    const page = await mount(<Gallery />);
    const shown = new Set(
      [...page.container.querySelectorAll("[data-gallery-item]")].map((el) =>
        el.getAttribute("data-gallery-item"),
      ),
    );
    expect(components.filter((name) => !shown.has(name))).toEqual([]);
    expect(
      [...page.container.querySelectorAll("[data-gallery-section]")].map((el) =>
        el.getAttribute("data-gallery-section"),
      ),
    ).toEqual(["brand", "primitives", "ai"]);
    await page.unmount();
  });

  it("starts from the theme and density of the address, and falls back on unknown ones", async () => {
    window.history.replaceState(null, "", "/dev/ui?theme=hc&density=comfortable");
    const page = await mount(<Gallery />);
    const frame = page.container.querySelector('[data-slot="gallery-frame"]');
    expect([frame?.getAttribute("data-theme"), frame?.getAttribute("data-density")]).toEqual([
      "hc",
      "comfortable",
    ]);
    await page.unmount();
    window.history.replaceState(null, "", "/dev/ui?theme=sepia&density=huge");
    const fallback = await mount(<Gallery />);
    const frames = fallback.container.querySelector('[data-slot="gallery-frame"]');
    expect([frames?.getAttribute("data-theme"), frames?.getAttribute("data-density")]).toEqual([
      "night",
      "compact",
    ]);
    await fallback.unmount();
  });

  it("renders nine frames when asked for all", async () => {
    window.history.replaceState(null, "", "/dev/ui?all=1");
    const page = await mount(<Gallery />);
    const frames = [...page.container.querySelectorAll('[data-slot="gallery-frame"]')];
    expect(frames.map((f) => `${f.getAttribute("data-theme")}/${f.getAttribute("data-density")}`)).toEqual([
      "night/compact",
      "night/comfortable",
      "night/mixed",
      "day/compact",
      "day/comfortable",
      "day/mixed",
      "hc/compact",
      "hc/comfortable",
      "hc/mixed",
    ]);
    await page.unmount();
  });

  it("gives every interactive element a 44-px coarse-pointer class (DESIGN §5, classes only)", async () => {
    window.history.replaceState(null, "", "/dev/ui");
    const page = await mount(<Gallery />);
    const bare = [...page.container.querySelectorAll(INTERACTIVE)]
      .filter((el) => !el.closest('[aria-hidden="true"], [hidden]'))
      // Links inside running text are exempt (WCAG 2.5.8's inline exception): a prose link cannot be 44 px tall.
      .filter((el) => !el.closest("[data-markdown-body]"))
      .filter(
        (el) =>
          ![el, el.parentElement, el.parentElement?.parentElement].some(
            (node) => node && COARSE_TARGET.test(node.getAttribute("class") ?? ""),
          ),
      )
      .map(
        (el) =>
          `${el.closest("[data-gallery-item]")?.getAttribute("data-gallery-item") ?? "?"}: <${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent?.slice(0, 20) ?? ""}>`,
      );
    expect(bare).toEqual([]);
    expect(page.container.querySelectorAll(INTERACTIVE).length).toBeGreaterThan(40);
    await page.unmount();
  });
});
