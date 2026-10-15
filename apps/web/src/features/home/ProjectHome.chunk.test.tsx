// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStaleChunk } from "../../lib/lazy.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, settle } from "../../testing/dom.ts";
import { resetHome, showHome } from "../../testing/home-bed.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined, notify: vi.fn() }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../lib/lazy.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/lazy.tsx")>()),
  notifyLazyFailure: current.notify,
}));
// A chunk that is gone after a pap update.
vi.mock("./run-launch.ts", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

beforeEach(() => {
  const bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  current.notify.mockClear();
  resetHome();
});

describe("ProjectHome: a launch whose chunk does not load", () => {
  it("says so with the lazy-failure text, and the composer is usable again", async () => {
    const { page, actions } = await showHome();
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(current.notify).toHaveBeenCalledOnce();
    expect(isStaleChunk(current.notify.mock.calls[0]?.[0])).toBe(true);
    expect(current.notify.mock.calls[0]?.[1]).toMatchObject({ stale: expect.any(String), reload: "Reload" });
    expect(actions.open).not.toHaveBeenCalled();
    expect(button(page.container, "Launch a session").disabled).toBe(false);
  });
});
