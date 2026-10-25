// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount } from "../testing/dom.ts";
import { Reasoning } from "./Reasoning.tsx";

const isOpen = (container: HTMLElement) =>
  container.querySelector('[data-slot="collapsible"]')?.getAttribute("data-state") === "open";

describe("Reasoning", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("streaming does not open the block, a click does, and the stream's end does not close it", async () => {
    const page = await mount(
      <Reasoning streaming label="Thinking…">
        step one
      </Reasoning>,
    );
    expect(isOpen(page.container)).toBe(false);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(isOpen(page.container)).toBe(true);
    await page.rerender(
      <Reasoning streaming={false} label="Thought for 14s">
        step one
      </Reasoning>,
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(isOpen(page.container)).toBe(true);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(isOpen(page.container)).toBe(false);
    await page.unmount();
  });

  it("starts closed for a finished message and leaves the person's choice alone", async () => {
    const page = await mount(
      <Reasoning streaming={false} label="Thought for 14s">
        step one
      </Reasoning>,
    );
    expect(isOpen(page.container)).toBe(false);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(isOpen(page.container)).toBe(true);
    await page.unmount();
  });
});
