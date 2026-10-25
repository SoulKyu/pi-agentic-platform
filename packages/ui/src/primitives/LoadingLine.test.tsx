// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { LoadingLine } from "./LoadingLine.tsx";

const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });

describe("LoadingLine", () => {
  it("nothing before 100 ms, the label after, elapsed from 3 s, the cause from 10 s", async () => {
    vi.useFakeTimers();
    try {
      const page = await mount(<LoadingLine label="Reading the file…" cause="Pi is busy" />);
      await advance(99);
      expect(page.container.textContent).toBe("");
      await advance(1);
      const status = page.container.querySelector('[role="status"]');
      expect(status?.getAttribute("aria-live")).toBeNull();
      expect(page.container.textContent).toContain("Reading the file…");
      expect(page.container.textContent).not.toContain("3 s");
      await advance(2900);
      expect(page.container.textContent).toContain("3 s");
      expect(page.container.textContent).not.toContain("Pi is busy");
      await advance(1000);
      expect(page.container.textContent).toContain("4 s");
      await advance(6000);
      expect(page.container.textContent).toContain("10 s");
      expect(page.container.textContent).toContain("Pi is busy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("deferred=false shows the label at once", async () => {
    vi.useFakeTimers();
    try {
      const page = await mount(<LoadingLine label="Loading…" deferred={false} />);
      expect(page.container.textContent).toContain("Loading…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shared since counts from the first wait", async () => {
    vi.useFakeTimers();
    try {
      const since = performance.now() - 5000;
      const page = await mount(<LoadingLine label="Loading…" since={since} deferred={false} />);
      expect(page.container.textContent).toContain("5 s");
      await advance(5000);
      expect(page.container.textContent).toContain("10 s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unmount leaves no timer", async () => {
    vi.useFakeTimers();
    try {
      const page = await mount(<LoadingLine label="Loading…" />);
      await advance(3500);
      await page.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
