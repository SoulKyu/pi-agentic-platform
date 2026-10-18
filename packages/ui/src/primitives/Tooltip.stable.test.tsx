// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mountWithTooltips } from "../testing/dom.ts";
import { Tooltip } from "./Tooltip.tsx";

// The popup chunk resolves only when the test says so, so the test owns the timing a real network would pick.
const gate = vi.hoisted(() => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
});
vi.mock("./TooltipPopup.tsx", async (importOriginal) => {
  await gate.opened;
  return importOriginal();
});

const flush = () => act(async () => {});
const hover = async (node: HTMLElement) => {
  await act(async () => {
    node.dispatchEvent(pointer("pointerover"));
    await import("./TooltipPopup.tsx");
  });
  await flush();
};
const openTooltip = async (node: HTMLElement) => {
  vi.useFakeTimers();
  try {
    await act(async () => {
      node.dispatchEvent(pointer("pointermove"));
      await vi.advanceTimersByTimeAsync(400);
    });
  } finally {
    vi.useRealTimers();
  }
};
const escape = () =>
  act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

const pointer = (type: string) => new PointerEvent(type, { bubbles: true, pointerType: "mouse" });

describe("Tooltip trigger identity (the chunk loads between pointerdown and pointerup)", () => {
  it("keeps the same DOM node and delivers exactly one click", async () => {
    const onClick = vi.fn();
    const page = await mountWithTooltips(
      <Tooltip label="New agent">
        <button type="button" onClick={onClick}>
          go
        </button>
      </Tooltip>,
    );
    const before = page.container.querySelector("button") as HTMLElement;
    await act(async () => {
      before.dispatchEvent(pointer("pointerover"));
      before.dispatchEvent(pointer("pointerdown"));
    });
    expect(page.container.querySelector('[data-slot="tooltip"]')).toBeNull(); // chunk still pending
    await act(async () => {
      gate.open();
      await import("./TooltipPopup.tsx"); // resolves once the gated chunk is in
    });
    await flush();
    const after = page.container.querySelector("button") as HTMLElement;
    expect.soft(after).toBe(before);
    expect.soft(before.isConnected).toBe(true);
    expect.soft(after.getAttribute("data-state")).toBe("closed"); // the popup did arm
    await act(async () => {
      before.dispatchEvent(pointer("pointerup"));
      before.click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    await page.unmount();
  });

  it("still describes the same node while open and closes on Escape", async () => {
    gate.open();
    const page = await mountWithTooltips(
      <Tooltip label="Inbox">
        <button type="button">inbox</button>
      </Tooltip>,
    );
    const node = page.container.querySelector("button") as HTMLElement;
    await hover(node);
    await openTooltip(node);
    expect(document.querySelector('[data-slot="tooltip"]')).not.toBeNull();
    expect(page.container.querySelector("button")).toBe(node);
    expect(node.getAttribute("data-state")).toBe("delayed-open");
    expect(node.getAttribute("aria-describedby")).not.toBeNull();
    await escape();
    expect(document.querySelector('[data-slot="tooltip"]')).toBeNull();
    expect(node.getAttribute("aria-describedby")).toBeNull();
    await page.unmount();
  });

  it("keeps the description the control already has: before arming, while open, after close and after unmount", async () => {
    gate.open();
    const page = await mountWithTooltips(
      <Tooltip label="Lane">
        <button type="button" aria-describedby="reason">
          lane
        </button>
      </Tooltip>,
    );
    const node = page.container.querySelector("button") as HTMLElement;
    expect(node.getAttribute("aria-describedby")).toBe("reason");
    await hover(node);
    expect(node.getAttribute("aria-describedby")).toBe("reason"); // armed, still closed
    await openTooltip(node);
    const tokens = (node.getAttribute("aria-describedby") ?? "").split(" ");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe("reason");
    expect(document.querySelector(`#${CSS.escape(tokens[1] ?? "")}`)).not.toBeNull();
    await escape();
    expect(node.getAttribute("aria-describedby")).toBe("reason");
    await page.unmount();
    expect(node.getAttribute("aria-describedby")).toBe("reason");
  });

  it("arms the new node when the control's node is replaced", async () => {
    gate.open();
    const page = await mountWithTooltips(
      <Tooltip label="Swap">
        <button type="button" key="a">
          one
        </button>
      </Tooltip>,
    );
    const first = page.container.querySelector("button") as HTMLElement;
    await hover(first);
    expect(first.getAttribute("data-state")).toBe("closed");
    await page.rerender(
      <Tooltip label="Swap">
        <button type="button" key="b">
          two
        </button>
      </Tooltip>,
    );
    const second = page.container.querySelector("button") as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.getAttribute("data-state")).toBeNull(); // bare again until it is hovered
    await hover(second);
    expect(second.getAttribute("data-state")).toBe("closed");
    await openTooltip(second);
    expect(document.querySelector('[data-slot="tooltip"]')).not.toBeNull();
    await page.unmount();
  });
});
