// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { click, mount } from "../testing/dom.ts";
import { StatusBar, Widgets } from "../extensions.ts";

const cells = [
  { kind: "command", key: "command:/mode", command: "/mode build", label: "Build" },
  { kind: "text", key: "ci", text: "\u001b[31mfailing\u001b[0m" },
] as const;
const base = { label: "Status", sourceLabel: "from an extension" } as const;

describe("StatusBar", () => {
  it("shows a command cell as a button with the label and the command beside it, and runs it", async () => {
    const onCommand = vi.fn();
    const page = await mount(<StatusBar {...base} cells={cells} busy={false} onCommand={onCommand} />);
    const buttons = [...page.container.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("Build /mode build");
    expect(buttons[0]?.querySelector(".font-mono.text-muted")?.textContent).toBe("/mode build");
    expect(buttons[0]?.hasAttribute("title")).toBe(false);
    await click(buttons[0] as HTMLElement);
    expect(onCommand).toHaveBeenCalledExactlyOnceWith("/mode build");
  });

  it("shows a label that pretends to be something else next to the command it really runs", async () => {
    const lying = [
      { kind: "command", key: "command:/deploy", command: "/deploy", label: "Show help" },
    ] as const;
    const page = await mount(<StatusBar {...base} cells={lying} busy={false} onCommand={() => {}} />);
    expect(page.container.querySelector("button")?.textContent).toBe("Show help /deploy");
  });

  it("is a named group that says whose text it is, with the error span on the err token", async () => {
    const page = await mount(<StatusBar {...base} cells={cells} busy={false} onCommand={() => {}} />);
    const group = page.container.querySelector('[role="group"]');
    expect(group?.getAttribute("data-slot")).toBe("status-bar");
    expect(group?.getAttribute("aria-label")).toBe("Status");
    expect(group?.textContent).toContain("from an extension");
    const red = [...page.container.querySelectorAll("span")].find(
      (s) => s.textContent === "failing" && !s.querySelector("span"),
    );
    expect(red?.className).toContain("text-err");
  });

  it("disables the buttons while busy", async () => {
    const onCommand = vi.fn();
    const page = await mount(<StatusBar {...base} cells={cells} busy onCommand={onCommand} />);
    const run = page.container.querySelector("button") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    await click(run);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("renders nothing without a cell", async () => {
    const page = await mount(<StatusBar {...base} cells={[]} busy={false} onCommand={() => {}} />);
    expect(page.container.innerHTML).toBe("");
  });
});

describe("Widgets", () => {
  const widgets = [
    { key: "a", lines: ["\u001b[31mred", "plain"], placement: "aboveEditor" },
    { key: "b", lines: ["below"], placement: "belowEditor" },
  ];

  it("shows the widgets of its placement, one parsed line each, the style reset on every line", async () => {
    const page = await mount(<Widgets widgets={widgets} placement="aboveEditor" />);
    const lines = [...page.container.querySelectorAll("[data-widget-line]")];
    expect(lines.map((line) => line.textContent)).toEqual(["red", "plain"]);
    expect(lines[0]?.querySelector("span")?.className).toContain("text-err");
    expect(lines[1]?.querySelector("span")?.className).not.toContain("text-err");
  });

  it("renders nothing for a placement without widgets", async () => {
    const page = await mount(<Widgets widgets={widgets.slice(0, 1)} placement="belowEditor" />);
    expect(page.container.innerHTML).toBe("");
  });
});
