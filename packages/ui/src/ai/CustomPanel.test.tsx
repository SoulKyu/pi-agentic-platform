// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { click, mount, press, typeInto } from "../testing/dom.ts";
import { CustomPanel, type CustomPanelProps } from "../extensions.ts";

const LABELS = {
  collapse: "Hide the panel",
  expand: "Show the panel",
  input: "Panel input",
  leave: "Ctrl+] leaves the panel",
  reach: "Press Tab to reach the panel",
} as const;

function props(overrides: Partial<CustomPanelProps> = {}) {
  return {
    panelId: "p1",
    lines: ["\u001b[32mok\u001b[0m", "plain"],
    waitingLabel: null,
    error: null,
    reachHint: false,
    labels: LABELS,
    shouldTakeFocus: () => true,
    ...overrides,
    onKeyData: vi.fn<(data: string) => void>(),
    onText: vi.fn<(text: string) => void>(),
    onLeave: vi.fn<() => void>(),
  };
}
const inputOf = (container: ParentNode) =>
  container.querySelector("[data-terminal-input] textarea") as HTMLTextAreaElement;

describe("CustomPanel", () => {
  it("shows its lines on role tokens, how to leave, the others waiting, and takes the focus", async () => {
    const page = await mount(<CustomPanel {...props({ waitingLabel: "1 more waiting" })} />);
    expect(page.container.textContent).toContain("1 more waiting");
    expect(page.container.textContent).toContain("Ctrl+] leaves the panel");
    expect(
      [...page.container.querySelectorAll("span")].find((s) => s.textContent === "ok")?.className,
    ).toContain("text-ok");
    expect(document.activeElement).toBe(inputOf(page.container));
    expect(inputOf(page.container).closest("label")?.textContent).toContain("Panel input");
  });

  it("does not take the focus when asked not to, and says how to reach it", async () => {
    const page = await mount(<CustomPanel {...props({ shouldTakeFocus: () => false, reachHint: true })} />);
    expect(document.activeElement).not.toBe(inputOf(page.container));
    expect(page.container.querySelector('[role="status"]')?.textContent).toBe("Press Tab to reach the panel");
  });

  it("turns keys into terminal data and keeps the keys it consumes to itself, Escape included", async () => {
    const p = props();
    const page = await mount(<CustomPanel {...p} />);
    const heard: string[] = [];
    const listen = (event: KeyboardEvent) => void heard.push(event.key);
    document.addEventListener("keydown", listen);
    try {
      const escape = await press(inputOf(page.container), { key: "Escape" });
      await press(inputOf(page.container), { key: "ArrowUp" });
      expect(escape.defaultPrevented).toBe(true);
      expect(heard).toEqual([]);
      expect(p.onKeyData.mock.calls).toEqual([["\u001b"], ["\u001b[A"]]);
    } finally {
      document.removeEventListener("keydown", listen);
    }
  });

  it("lets Ctrl+V and Meta shortcuts through to the browser and sends nothing", async () => {
    const p = props();
    const page = await mount(<CustomPanel {...p} />);
    const paste = await press(inputOf(page.container), { key: "v", ctrlKey: true });
    const copy = await press(inputOf(page.container), { key: "c", metaKey: true });
    expect([paste.defaultPrevented, copy.defaultPrevented]).toEqual([false, false]);
    expect(p.onKeyData).not.toHaveBeenCalled();
  });

  it("Ctrl+] leaves without sending", async () => {
    const p = props();
    const page = await mount(<CustomPanel {...p} />);
    const leave = await press(inputOf(page.container), { key: "]", ctrlKey: true });
    expect(leave.defaultPrevented).toBe(true);
    expect(p.onLeave).toHaveBeenCalledTimes(1);
    expect(p.onKeyData).not.toHaveBeenCalled();
  });

  it("sends typed text and empties the field; an IME sends the composed text once", async () => {
    const p = props();
    const page = await mount(<CustomPanel {...p} />);
    const input = inputOf(page.container);
    await typeInto(input, "pasted");
    expect(p.onText.mock.calls).toEqual([["pasted"]]);
    expect(input.value).toBe("");
    await act(() => input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await press(input, { key: "Process", isComposing: true });
    await typeInto(input, "ni");
    expect(p.onText).toHaveBeenCalledTimes(1);
    await typeInto(input, "你");
    await act(() => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    expect(p.onText.mock.calls).toEqual([["pasted"], ["你"]]);
    expect(input.value).toBe("");
    expect(p.onKeyData).not.toHaveBeenCalled();
  });

  it("keeps iOS from zooming on focus and gives touch a full-height field", async () => {
    const page = await mount(<CustomPanel {...props()} />);
    const classes = inputOf(page.container).className.split(/\s+/);
    expect(classes).toContain("pointer-coarse:text-base");
    expect(classes).toContain("pointer-coarse:min-h-11");
  });

  it("collapses to the toggle, and takes the focus again on expand", async () => {
    const page = await mount(<CustomPanel {...props()} />);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(page.container.querySelector("[data-terminal-input]")).toBeNull();
    expect(page.container.querySelector("button")?.textContent).toBe("Show the panel");
    await click(page.container.querySelector("button") as HTMLElement);
    expect(page.container.textContent).toContain("plain");
    expect(document.activeElement).toBe(inputOf(page.container));
  });

  it("shows the error as an alert and renders nothing without a panel", async () => {
    const page = await mount(<CustomPanel {...props({ error: "Not found." })} />);
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe("Not found.");
    await page.rerender(<CustomPanel {...props({ panelId: undefined })} />);
    expect(page.container.innerHTML).toBe("");
  });

  it("hands the focus back when the panel closes while it held it", async () => {
    const p = props();
    const page = await mount(<CustomPanel {...p} />);
    expect(document.activeElement).toBe(inputOf(page.container));
    await page.rerender(<CustomPanel {...p} panelId={undefined} />);
    expect(p.onLeave).toHaveBeenCalledTimes(1);
  });
});
