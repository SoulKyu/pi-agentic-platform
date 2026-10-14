// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { button, click, mount, press } from "../testing/dom.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";

const LABELS = { deny: "Deny", session: "Session", always: "Always", once: "Allow once" } as const;
const COLLAPSE = {
  show: "Show all 12 lines",
  hide: "Collapse",
  blocked: "Show the whole command to allow it",
} as const;
const FIRST_TWO = "step-1\nstep-2";
const LONG = Array.from({ length: 12 }, (_, i) => `step-${i + 1}`).join("\n");
const HIDING = ["hidden", "sr-only", "invisible", "h-0", "size-0", "opacity-0"];

const card = (detail: string, extra: Partial<Parameters<typeof ApprovalCard>[0]> = {}) => (
  <ApprovalCard
    title="Approval"
    category="exec"
    detail={detail}
    collapse={COLLAPSE}
    labels={LABELS}
    onChoose={() => {}}
    {...extra}
  />
);
const body = (container: HTMLElement) => container.querySelector("[data-approval-scroll]") as HTMLElement;

/** What a person could see: in the page, not hidden by an attribute, ARIA or a hiding class, on the box or above it. */
function shown(element: Element | null): boolean {
  for (
    let node = element;
    node !== null && node.getAttribute("role") !== "alertdialog";
    node = node.parentElement
  ) {
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
    if (node.className.split(/\s+/).some((name) => HIDING.includes(name))) return false;
  }
  return element !== null;
}

describe("ApprovalCard, compact form", () => {
  it("always renders the command, in mono: two lines when collapsed, the whole text once expanded", async () => {
    const page = await mount(card(`12 lines\n${LONG}`));
    expect(shown(body(page.container))).toBe(true);
    expect(body(page.container).textContent).toBe(FIRST_TWO);
    expect(body(page.container).className).toContain("font-mono");
    await click(button(page.container, "Show all 12 lines"));
    expect(shown(body(page.container))).toBe(true);
    expect(body(page.container).textContent).toBe(LONG);
    await page.unmount();
  });

  it("starts collapsed and gated again when the command text changes after an expand", async () => {
    const page = await mount(card(`12 lines\n${LONG}`));
    await click(button(page.container, "Show all 12 lines"));
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(false);
    await page.rerender(card(`12 lines\n${LONG.replace("step-12", "rm -rf ~")}`));
    expect(body(page.container).textContent).toBe(FIRST_TWO);
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(true);
    await page.unmount();
  });

  it("shows a short command whole, with no button", async () => {
    const page = await mount(card("1 line\nls -la"));
    expect(shown(body(page.container))).toBe(true);
    expect(body(page.container).className).not.toContain("line-clamp");
    expect(page.container.querySelector("[aria-expanded]")).toBeNull();
    await page.unmount();
  });

  it("shows two lines when collapsed, with no clamp or ellipsis, and a button shows and hides the rest", async () => {
    const page = await mount(card(`12 lines\n${LONG}`));
    expect(body(page.container).textContent).toBe(FIRST_TWO);
    expect(body(page.container).className).not.toMatch(/line-clamp|truncate|text-ellipsis/);
    expect(body(page.container).getAttribute("tabindex")).toBeNull();
    const toggle = button(page.container, "Show all 12 lines");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(body(page.container).id);
    await click(toggle);
    expect(body(page.container).textContent).toBe(LONG);
    expect(body(page.container).className).not.toMatch(/max-h|overflow/);
    expect(body(page.container).getAttribute("tabindex")).toBeNull();
    expect(button(page.container, "Collapse").getAttribute("aria-expanded")).toBe("true");
    await click(button(page.container, "Collapse"));
    expect(body(page.container).textContent).toBe(FIRST_TWO);
    await page.unmount();
  });

  it("gates a 1-line command of 1000 characters, shows it whole once expanded, in the flow with no inner scroll", async () => {
    const line = "x".repeat(1000);
    const onChoose = vi.fn();
    const page = await mount(
      card(`1 line\n${line}`, { collapse: { ...COLLAPSE, show: "Show all" }, onChoose }),
    );
    const box = () => body(page.container);
    expect(box().textContent).toBe("x".repeat(300));
    expect(box().className).toContain("break-all");
    expect(box().className).not.toMatch(/line-clamp|truncate|text-ellipsis|overflow|max-h/);
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(true);
    expect(page.container.querySelector("[data-approval-blocked]")).not.toBeNull();
    await click(button(page.container, "Show all"));
    expect(shown(box())).toBe(true);
    expect(box().textContent).toBe(line);
    expect(box().className).not.toMatch(/max-h|overflow|truncate|line-clamp/);
    expect(box().getAttribute("tabindex")).toBeNull();
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(false);
    await page.unmount();
  });

  it("allows at once a command of 300 characters, and gates one of 301", async () => {
    const edge = await mount(card(`1 line\n${"y".repeat(300)}`));
    expect((button(edge.container, "Allow once") as HTMLButtonElement).disabled).toBe(false);
    expect(edge.container.querySelector("[aria-expanded]")).toBeNull();
    await edge.unmount();
    const over = await mount(card(`1 line\n${"y".repeat(301)}`));
    expect((button(over.container, "Allow once") as HTMLButtonElement).disabled).toBe(true);
    await over.unmount();
  });

  it("counts characters, not UTF-16 units: 300 emoji are not long", async () => {
    const page = await mount(card(`1 line\n${"😀".repeat(300)}`));
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(false);
    await page.unmount();
  });

  it("gates a header line longer than the limit and shows it whole, with no clipping box, once expanded", async () => {
    const head = "h".repeat(1000);
    const page = await mount(card(`${head}\nls`, { collapse: { ...COLLAPSE, show: "Show all" } }));
    const header = () => page.container.querySelector("[data-approval-header]") as HTMLElement;
    expect(header().textContent).toBe("h".repeat(300));
    expect(header().className).not.toMatch(/max-h|overflow/);
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(true);
    await click(button(page.container, "Show all"));
    expect(header().textContent).toBe(head);
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(false);
    await page.unmount();
  });

  it("holds Allow while the caller withholds part of the command, with one expand button at most", async () => {
    const page = await mount(card(`12 lines\n${LONG}`, { withheld: true }));
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(true);
    expect(page.container.querySelector("[aria-expanded]")).toBeNull();
    expect(body(page.container).textContent).toBe(LONG);
    expect(page.container.querySelector("[data-approval-blocked]")).not.toBeNull();
    await page.unmount();
  });

  it("keeps Allow once, Session and Always disabled for a 3-line command until it is expanded; Deny always works", async () => {
    const onChoose = vi.fn();
    const page = await mount(
      card("3 lines\na\nb\nc", { collapse: { ...COLLAPSE, show: "Show all 3 lines" }, onChoose }),
    );
    for (const name of ["Session", "Always", "Allow once"])
      expect((button(page.container, name) as HTMLButtonElement).disabled).toBe(true);
    expect((button(page.container, "Deny") as HTMLButtonElement).disabled).toBe(false);
    expect(page.container.querySelector("[data-approval-blocked]")?.textContent).toBe(COLLAPSE.blocked);
    await click(button(page.container, "Allow once"));
    expect(onChoose).not.toHaveBeenCalled();
    await click(button(page.container, "Show all 3 lines"));
    for (const name of ["Session", "Always", "Allow once"])
      expect((button(page.container, name) as HTMLButtonElement).disabled).toBe(false);
    expect(page.container.querySelector("[data-approval-blocked]")).toBeNull();
    await click(button(page.container, "Allow once"));
    expect(onChoose.mock.calls).toEqual([["once"]]);
    await page.unmount();
  });

  it("allows a 2-line command at once", async () => {
    const page = await mount(card("2 lines\na\nb"));
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(false);
    expect(page.container.querySelector("[data-approval-blocked]")).toBeNull();
    await page.unmount();
  });

  it("collapsing again blocks Allow again; the keyboard (Enter, Space) cannot answer a blocked card, Deny still can", async () => {
    const onChoose = vi.fn();
    const page = await mount(
      card("3 lines\na\nb\nc", { collapse: { ...COLLAPSE, show: "Show all 3 lines" }, onChoose }),
    );
    await click(button(page.container, "Show all 3 lines"));
    await click(button(page.container, "Collapse"));
    const once = button(page.container, "Allow once") as HTMLButtonElement;
    expect(once.disabled).toBe(true);
    for (const key of ["Enter", " "]) {
      await press(once, { key });
      await click(once);
    }
    expect(onChoose).not.toHaveBeenCalled();
    await click(button(page.container, "Deny"));
    expect(onChoose.mock.calls).toEqual([["deny"]]);
    await page.unmount();
  });

  it("keeps the header line, the question, the context, the controls and the note on the card", async () => {
    const page = await mount(
      card(`12 lines, 1 hidden character shown escaped\n${LONG}`, {
        taintLabel: "External content",
        question: <p data-q>Run it?</p>,
        context: <span data-ctx>+3 -1</span>,
        controls: <label data-scope>Exact command</label>,
        note: <span data-n>Closes on its own after 30 s</span>,
      }),
    );
    const c = page.container;
    for (const selector of [
      "[data-approval-header]",
      "[data-q]",
      "[data-ctx]",
      "[data-scope]",
      "[data-n]",
      '[data-tone="ext"]',
    ]) {
      expect(shown(c.querySelector(selector)), selector).toBe(true);
    }
    await page.unmount();
  });

  it("puts the controls, the note and the four answers on one row, answers at the end", async () => {
    const page = await mount(
      card(`12 lines\n${LONG}`, { controls: <label>Exact command</label>, note: <span>Closes soon</span> }),
    );
    const row = button(page.container, "Allow once").parentElement?.parentElement as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    expect(row.textContent).toContain("Show all 12 lines");
    expect(row.textContent).toContain("Exact command");
    expect(row.textContent).toContain("Closes soon");
    for (const name of ["Deny", "Session", "Always", "Allow once"])
      expect(button(page.container, name).parentElement?.parentElement).toBe(row);
    expect(button(page.container, "Deny").parentElement?.className).toContain("order-last");
    await page.unmount();
  });

  it("is padded by the 8 px step, not the 12 px one, and its buttons are the 24 px size", async () => {
    const page = await mount(card("1 line\nls"));
    const section = page.container.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(section.className).toContain("p-s2");
    expect(section.className).not.toContain("p-s3");
    expect(button(page.container, "Deny").className).toContain("h-6");
    await page.unmount();
  });

  it("shows the whole command and gates nothing when the caller does not ask for the compact form", async () => {
    const page = await mount(card(`12 lines\n${LONG}`, { collapse: undefined }));
    expect(page.container.querySelector("[aria-expanded]")).toBeNull();
    expect(body(page.container).textContent).toBe(LONG);
    expect((button(page.container, "Allow once") as HTMLButtonElement).disabled).toBe(false);
    await page.unmount();
  });
});
