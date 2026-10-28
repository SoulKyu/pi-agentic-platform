// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { useComposerInsert } from "../../../stores/composer-insert.ts";
import { button, click, mount } from "../../../testing/dom.ts";
import { clearSelection, QuoteFixture, select } from "../../../testing/quote-bed.tsx";
import { QuoteStrip } from "./QuoteStrip.tsx";
import { QuoteToolbar } from "./QuoteToolbar.tsx";

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? coarse : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window, "matchMedia", { value: globalThis.matchMedia, configurable: true });
}

beforeEach(() => {
  setLocale("en");
  useComposerInsert.getState().reset();
});
afterEach(async () => {
  await clearSelection();
  vi.unstubAllGlobals();
});

describe("QuoteStrip", () => {
  it("with a coarse pointer the strip is above the composer while the selection lasts, and goes with it", async () => {
    pointer(true);
    const page = await mount(
      <QuoteFixture>
        <QuoteStrip sessionId="s1" />
        <QuoteToolbar sessionId="s1" />
      </QuoteFixture>,
    );
    expect(document.querySelector("[data-quote-strip]")).toBeNull();
    await select("reply-1");
    expect(document.querySelector("[data-quote-strip]")?.getAttribute("role")).toBe("toolbar");
    expect(document.querySelector("[data-quote-toolbar]")).toBeNull();
    await click(button(page.container, "Quote"));
    expect(useComposerInsert.getState().items["s1"]?.text).toBe("> First reply with a passage to quote\n\n");
    await select("reply-1");
    await clearSelection();
    expect(document.querySelector("[data-quote-strip]")).toBeNull();
  });

  it("with a fine pointer there is no strip", async () => {
    pointer(false);
    await mount(
      <QuoteFixture>
        <QuoteStrip sessionId="s1" />
      </QuoteFixture>,
    );
    await select("reply-1");
    expect(document.querySelector("[data-quote-strip]")).toBeNull();
  });
});
