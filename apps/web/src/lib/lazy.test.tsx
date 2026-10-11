// @vitest-environment happy-dom
import { act, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, click, mount } from "../testing/dom.ts";
import { LazyBoundary, useRetryableLazy } from "./lazy.tsx";

function Host({ load, onError }: { load: () => Promise<{ default: ComponentType }>; onError(): void }) {
  const { Lazy, attempt, retry } = useRetryableLazy(load);
  return (
    <>
      <button type="button" onClick={retry}>
        retry
      </button>
      <LazyBoundary resetKey={attempt} onError={onError}>
        <Lazy />
      </LazyBoundary>
    </>
  );
}

describe("lazy chunks (M3-RT-15)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a chunk that fails to load renders nothing, reports once, and the next attempt loads again", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {}); // React logs the caught error
    const Panel = () => <p>panel</p>;
    const load = vi
      .fn<() => Promise<{ default: ComponentType }>>()
      .mockRejectedValueOnce(new Error("chunk gone"))
      .mockResolvedValue({ default: Panel });
    const onError = vi.fn();
    const page = await mount(<Host load={load} onError={onError} />);
    await act(async () => {
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce(), { timeout: 2_000 });
    });
    expect(page.container.textContent).toBe("retry");
    await click(button(page.container, "retry"));
    await act(async () => {
      await vi.waitFor(() => expect(page.container.textContent).toContain("panel"), { timeout: 2_000 });
    });
    expect([load.mock.calls.length, onError.mock.calls.length]).toEqual([2, 1]);
    // A boundary without getDerivedStateFromError makes React warn; the caught chunk error itself is expected.
    expect(logged.mock.calls.filter((call) => String(call[0]).includes("getDerivedStateFromError"))).toEqual(
      [],
    );
    await page.unmount();
  });
});
