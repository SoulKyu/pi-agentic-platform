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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
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
    const page = await mountWithTooltips(
      <Tooltip label="Inbox">
        <button type="button">inbox</button>
      </Tooltip>,
    );
    const node = page.container.querySelector("button") as HTMLElement;
    await act(async () => {
      node.dispatchEvent(pointer("pointerover"));
      await import("./TooltipPopup.tsx");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.useFakeTimers();
    try {
      await act(async () => {
        node.dispatchEvent(pointer("pointermove"));
        await vi.advanceTimersByTimeAsync(400);
      });
    } finally {
      vi.useRealTimers();
    }
    const content = document.querySelector('[data-slot="tooltip"]');
    expect(content).not.toBeNull();
    expect(page.container.querySelector("button")).toBe(node);
    expect(node.getAttribute("data-state")).toBe("delayed-open");
    expect(node.getAttribute("aria-describedby")).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[data-slot="tooltip"]')).toBeNull();
    expect(node.getAttribute("aria-describedby")).toBeNull();
    await page.unmount();
  });
});
