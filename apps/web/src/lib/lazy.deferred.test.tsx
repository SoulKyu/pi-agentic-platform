// @vitest-environment happy-dom
import { act, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { LazyBoundary, useRetryableLazy } from "./lazy.tsx";

function Host({ load, onError }: { load: () => Promise<{ default: ComponentType }>; onError(): void }) {
  const { Lazy, attempt } = useRetryableLazy(load);
  return (
    <LazyBoundary resetKey={attempt} onError={onError} fallback={<p>loading line</p>}>
      <Lazy />
    </LazyBoundary>
  );
}

const Panel = () => <p>panel</p>;

describe("LazyBoundary fallback timing (DESIGN.md 7.3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a chunk that resolves within 100 ms never shows its fallback", async () => {
    let resolve: (value: { default: ComponentType }) => void = () => {};
    const load = () => new Promise<{ default: ComponentType }>((done) => (resolve = done));
    const page = await mount(<Host load={load} onError={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(page.container.textContent).not.toContain("loading line");
    await act(async () => {
      resolve({ default: Panel });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(page.container.textContent).toContain("panel");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(page.container.textContent).not.toContain("loading line");
    await page.unmount();
  });

  it("a slow one shows it after 100 ms", async () => {
    const load = () => new Promise<{ default: ComponentType }>(() => {});
    const page = await mount(<Host load={load} onError={() => {}} />);
    expect(page.container.textContent).not.toContain("loading line");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(110);
    });
    expect(page.container.textContent).toContain("loading line");
    await page.unmount();
  });

  it("a failed one shows its retry at once", async () => {
    const load = () => Promise.reject(new Error("Failed to fetch dynamically imported module"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    const page = await mount(<Host load={load} onError={onError} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(page.container.textContent).toContain("loading line");
    await page.unmount();
  });
});
