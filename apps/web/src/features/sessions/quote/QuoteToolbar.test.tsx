// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { useComposerInsert } from "../../../stores/composer-insert.ts";
import { useKnowledgeEnabled } from "../../../stores/knowledge-enabled.ts";
import { button, hasButton, click, mount, settle } from "../../../testing/dom.ts";
import { clearSelection, QuoteFixture, select } from "../../../testing/quote-bed.tsx";
import { QuoteToolbar } from "./QuoteToolbar.tsx";

beforeEach(() => {
  setLocale("en");
  useComposerInsert.getState().reset();
  useKnowledgeEnabled.getState().reset();
});
afterEach(async () => {
  await clearSelection();
});

const show = () =>
  mount(
    <QuoteFixture>
      <QuoteToolbar sessionId="s1" />
    </QuoteFixture>,
  );
const toolbar = () => document.querySelector("[data-quote-toolbar]");

describe("QuoteToolbar", () => {
  it("QUOTE inserts the quote at the composer's caret and sends nothing", async () => {
    const page = await show();
    expect(toolbar()).toBeNull();
    await select("reply-1");
    expect(toolbar()?.getAttribute("role")).toBe("toolbar");
    expect(toolbar()?.getAttribute("aria-label")).toBe("Selection");
    await click(button(page.container, "Quote"));
    expect(useComposerInsert.getState().items["s1"]?.text).toBe("> First reply with a passage to quote\n\n");
    expect(toolbar()).toBeNull();
  });

  it("TO KNOWLEDGE shows only when OKF is on for this session", async () => {
    const page = await show();
    await select("reply-1");
    expect(hasButton(page.container, "To knowledge")).toBe(false);
    useKnowledgeEnabled.getState().setEnabled("s1", true);
    await settle();
    await click(button(page.container, "To knowledge"));
    const text = useComposerInsert.getState().items["s1"]?.text ?? "";
    expect(text).toBe(
      "Record the passage below as a concept in this project's knowledge folder (knowledge/).\n\n> First reply with a passage to quote\n\n",
    );
  });

  it("a wide bar near the right edge stays inside the viewport", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(420);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(44);
    vi.stubGlobal("innerWidth", 1000);
    const rect = { left: 900, right: 990, top: 300, bottom: 320, width: 90, height: 20, x: 900, y: 300 };
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    await show();
    await select("reply-1");
    const bar = toolbar() as HTMLElement;
    const left = Number.parseFloat(bar.style.left);
    expect(left + 420).toBeLessThanOrEqual(1000 - 8);
    expect(left).toBeGreaterThanOrEqual(8);
    width.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pointer-down on the toolbar keeps the selection", async () => {
    await show();
    await select("reply-1");
    const bar = toolbar() as HTMLElement;
    for (const type of ["mousedown", "pointerdown"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      bar.querySelector("button")?.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(true);
    }
  });
});
