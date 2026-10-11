// @vitest-environment happy-dom
import * as ui from "@pap/ui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { galleryEn, galleryFr } from "../i18n/catalog/gallery.ts";
import { setLocale } from "../i18n/index.ts";
import { Gallery } from "./Gallery.tsx";

// Exports that are not components to show: providers, hooks, helpers, constants and types erase at runtime.
const NOT_SHOWN = new Set(["TooltipProvider", "Toaster"]);
// The glyph exports (IconAccount, IconBack...) are data for Icon; Icon and IconButton are components and are checked.
const GLYPHS = /^Icon(?!Button$)[A-Z]/;
const components = Object.entries(ui)
  .filter(
    ([name, value]) =>
      typeof value === "function" && /^[A-Z]/.test(name) && !GLYPHS.test(name) && !NOT_SHOWN.has(name),
  )
  .map(([name]) => name);

const INTERACTIVE =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [role="combobox"], [role="menuitem"]';
const PROBED_CONTROLS = 68;
// Both dimensions: `size-11`, or a minimum height together with a minimum width (`pointer-coarse:min-w-11`, or
// `w-full` for a control that fills its row) (m2 of the final review).
const hasClass = (classes: string, name: string) => classes.split(/\s+/).includes(name);
const isCoarseTarget = (classes: string) =>
  hasClass(classes, "pointer-coarse:size-11") ||
  ((hasClass(classes, "pointer-coarse:min-w-11") || hasClass(classes, "w-full")) &&
    (hasClass(classes, "pointer-coarse:min-h-11") || hasClass(classes, "pointer-coarse:h-11")));

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
    // The lazy Markdown chunk has rendered: its links are then in the page and exempt by rule, not by absence.
    await vi.waitFor(() => expect(page.container.querySelector("[data-markdown-body]")).not.toBeNull(), {
      timeout: 5_000,
    });
    const probed = [...page.container.querySelectorAll(INTERACTIVE)]
      .filter((el) => !el.closest('[aria-hidden="true"], [hidden]'))
      // Links inside running text are exempt (WCAG 2.5.8's inline exception): a prose link cannot be 44 px tall.
      .filter((el) => !(el.matches("a[href]") && el.closest("[data-markdown-body]")));
    const bare = probed
      .filter(
        (el) =>
          ![el, el.parentElement, el.parentElement?.parentElement].some(
            (node) => node && isCoarseTarget(node.getAttribute("class") ?? ""),
          ),
      )
      .map(
        (el) =>
          `${el.closest("[data-gallery-item]")?.getAttribute("data-gallery-item") ?? "?"}: <${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent?.slice(0, 20) ?? ""}>`,
      );
    expect(bare).toEqual([]);
    // Exact on purpose: adding or removing a control is a deliberate edit of this number.
    expect(probed).toHaveLength(PROBED_CONTROLS);
    await page.unmount();
  });

  it("gives every element id once, also in the nine-frame view", async () => {
    window.history.replaceState(null, "", "/dev/ui?all=1");
    const page = await mount(<Gallery />);
    const ids = [...page.container.querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    await page.unmount();
  });

  it("says in the overlay section that portaled overlays follow the app theme, not the frame's", async () => {
    window.history.replaceState(null, "", "/dev/ui");
    const page = await mount(<Gallery />);
    const note = () => page.container.querySelector('[data-gallery-note="overlays"]')?.textContent;
    expect(note()).toBe(galleryEn["gallery.overlayNote"]);
    expect(galleryEn["gallery.overlayNote"]).toContain("not the frame");
    await act(async () => setLocale("fr"));
    expect(page.container.querySelector('[data-gallery-note="overlays"]')?.textContent).toBe(
      galleryFr["gallery.overlayNote"],
    );
    setLocale("en");
    const adr = readFileSync(
      join(import.meta.dirname, "../../../../docs/adr/0011-dev-ui-not-shipped.md"),
      "utf8",
    );
    expect(adr.replace(/\s+/g, " ")).toContain("follow the app's active theme and density, not the frame's");
    await page.unmount();
  });
});
