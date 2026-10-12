// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, text, type Mounted } from "../../testing/dom.ts";
import { StatusBar } from "./StatusBar.tsx";
import { Widgets } from "./Widgets.tsx";

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const statuses = [
  { key: "command:/mode build", text: "\u001b[32mBuild\u001b[0m" },
  { key: "ci", text: "\u001b[31mfailing\u001b[0m" },
];

describe("StatusBar", () => {
  it("shows a command cell as a button with the label and the command, and runs the command", async () => {
    const onCommand = vi.fn();
    page = await mount(<StatusBar statuses={statuses} busy={false} onCommand={onCommand} />);
    const buttons = [...page.container.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    const run = buttons[0] as HTMLButtonElement;
    expect(run.textContent).toContain("Build");
    expect(run.textContent).toContain("/mode build");
    expect(run.querySelector(".font-mono.text-muted")?.textContent).toBe("/mode build");
    expect(run.hasAttribute("title")).toBe(false);
    await click(run);
    expect(onCommand).toHaveBeenCalledExactlyOnceWith("/mode build");
  });

  it("makes a label that pretends to be something else visible as such (M2R135)", async () => {
    page = await mount(
      <StatusBar
        statuses={[{ key: "command:/deploy", text: "Show help" }]}
        busy={false}
        onCommand={vi.fn()}
      />,
    );
    expect(page.container.querySelector("button")?.textContent).toBe("Show help /deploy");
  });

  it("disables the buttons while the session is busy", async () => {
    const onCommand = vi.fn();
    page = await mount(<StatusBar statuses={statuses} busy onCommand={onCommand} />);
    const run = page.container.querySelector("button") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    await click(run);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("renders a text status as text, its red span on the error token, and says it comes from an extension (M2R138)", async () => {
    page = await mount(<StatusBar statuses={statuses} busy={false} onCommand={vi.fn()} />);
    const red = [...page.container.querySelectorAll("span")].find(
      (span) => span.textContent === "failing" && !span.querySelector("span"),
    );
    expect(red?.className).toContain("text-error");
    expect(text(page.container)).toContain("from an extension");
  });

  it("renders nothing when there is no cell", async () => {
    page = await mount(
      <StatusBar statuses={[{ key: "k", text: "\u001b[0m " }]} busy={false} onCommand={vi.fn()} />,
    );
    expect(page.container.innerHTML).toBe("");
  });
});

describe("Widgets", () => {
  const widgets = [
    { key: "a", lines: ["\u001b[31mred", "plain"], placement: "aboveEditor" as const },
    { key: "b", lines: ["below"], placement: "belowEditor" as const },
  ];

  it("shows only the widgets of its placement, one line each, with the style reset on every line", async () => {
    page = await mount(<Widgets widgets={widgets} placement="aboveEditor" />);
    expect(text(page.container)).toContain("red");
    expect(text(page.container)).not.toContain("below");
    const lines = [...page.container.querySelectorAll("[data-widget-line]")];
    expect(lines.map((line) => line.textContent)).toEqual(["red", "plain"]);
    expect(lines[0]?.querySelector("span")?.className).toContain("text-error");
    expect(lines[1]?.querySelector("span")?.className).not.toContain("text-error");
  });

  it("renders nothing for a placement without widgets", async () => {
    page = await mount(
      <Widgets widgets={[widgets[0] as (typeof widgets)[number]]} placement="belowEditor" />,
    );
    expect(page.container.innerHTML).toBe("");
  });
});
