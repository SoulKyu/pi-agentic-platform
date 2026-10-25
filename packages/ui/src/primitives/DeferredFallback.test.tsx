// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { DeferredFallback } from "./DeferredFallback.tsx";

describe("DeferredFallback", () => {
  it("renders nothing before 100 ms and its children after", async () => {
    vi.useFakeTimers();
    try {
      const page = await mount(<DeferredFallback>Loading…</DeferredFallback>);
      expect(page.container.textContent).toBe("");
      await act(async () => {
        vi.advanceTimersByTime(99);
      });
      expect(page.container.textContent).toBe("");
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(page.container.textContent).toBe("Loading…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unmount before 100 ms leaves no timer", async () => {
    vi.useFakeTimers();
    try {
      const page = await mount(<DeferredFallback>Loading…</DeferredFallback>);
      expect(vi.getTimerCount()).toBe(1);
      await page.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
