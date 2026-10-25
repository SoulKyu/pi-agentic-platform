// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { button, click, mount } from "../testing/dom.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";

const LABELS = { deny: "Deny", session: "Session", always: "Always", once: "Allow once" } as const;

describe("ApprovalCard as the session screen uses it", () => {
  it("is named by role and accessible name, and its heading separator is hidden from assistive technology", async () => {
    const page = await mount(
      <ApprovalCard
        title="Approval"
        category="exec"
        detail="1 line\nls"
        labels={LABELS}
        onChoose={() => {}}
      />,
    );
    const card = page.container.querySelector('[role="alertdialog"]');
    expect(card?.getAttribute("aria-label")).toBe("Approval exec");
    // The separator is its own aria-hidden span: the heading's text is not "Approval · exec".
    const heading = page.container.querySelector("h2");
    expect(heading?.textContent).toBe("Approval·exec");
    expect(heading?.querySelector('[aria-hidden="true"]')?.textContent).toBe("·");
    await page.unmount();
  });

  it("keeps Escape to itself: the card root is an inline edit", async () => {
    const page = await mount(<ApprovalCard title="A" detail="x" labels={LABELS} onChoose={() => {}} />);
    expect(page.container.querySelector('[role="alertdialog"]')?.hasAttribute("data-inline-edit")).toBe(true);
    await page.unmount();
  });

  it("shows the question above the detail and the note under the answers", async () => {
    const page = await mount(
      <ApprovalCard
        title="Approval"
        detail={"header\nbody"}
        question={<p data-q>Run a command?</p>}
        note={<p data-n>Closes on its own</p>}
        labels={LABELS}
        onChoose={() => {}}
      />,
    );
    const html = page.container.innerHTML;
    expect(html.indexOf("data-q")).toBeLessThan(html.indexOf("data-approval-header"));
    expect(html.indexOf("data-n")).toBeGreaterThan(html.indexOf("Allow once"));
    await page.unmount();
  });

  it("describes the card by its question, header, body and context", async () => {
    const page = await mount(
      <ApprovalCard
        title="Approval"
        detail={"header\nbody"}
        question={<p>Run a command?</p>}
        context={<span data-ctx>+3 -1</span>}
        labels={LABELS}
        onChoose={() => {}}
      />,
    );
    const card = page.container.querySelector('[role="alertdialog"]');
    const ids = (card?.getAttribute("aria-describedby") ?? "").split(" ");
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(expect.arrayContaining(["Run a command?", "header", "body", "+3 -1"]));
    await page.unmount();
  });

  it("shows the header in the flow, with no clipping box and no tab stop", async () => {
    const page = await mount(
      <ApprovalCard
        title="Approval"
        detail={`${"h".repeat(3000)}\nbody`}
        labels={LABELS}
        onChoose={() => {}}
      />,
    );
    const header = page.container.querySelector("[data-approval-header]");
    expect(header?.textContent).toBe("h".repeat(3000));
    expect(header?.className).not.toMatch(/max-h|overflow/);
    expect(header?.getAttribute("tabindex")).toBeNull();
    await page.unmount();
  });

  it("is not a tab stop when nothing scrolls", async () => {
    const page = await mount(
      <ApprovalCard title="Approval" detail={"h\nb"} labels={LABELS} onChoose={() => {}} />,
    );
    expect(page.container.querySelector("[data-approval-header]")?.getAttribute("tabindex")).toBeNull();
    await click(button(page.container, "Deny"));
    await page.unmount();
  });

  it("keeps the controls out of the description and under the context", async () => {
    const page = await mount(
      <ApprovalCard
        title="Approval"
        detail={"header\nbody"}
        question={<p>Run a command?</p>}
        context={<span>+3 -1</span>}
        controls={<button type="button">Show more</button>}
        labels={LABELS}
        onChoose={() => {}}
      />,
    );
    const card = page.container.querySelector('[role="alertdialog"]');
    const ids = (card?.getAttribute("aria-describedby") ?? "").split(" ");
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts.join("|")).not.toContain("Show more");
    const html = page.container.innerHTML;
    expect(html.indexOf("Show more")).toBeGreaterThan(html.indexOf("+3 -1"));
    expect(html.indexOf("Show more")).toBeLessThan(html.indexOf("Deny"));
    await page.unmount();
  });
});
