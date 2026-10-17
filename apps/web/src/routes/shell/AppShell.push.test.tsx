// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { usePwa } from "../../stores/pwa.ts";
import { settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const start = vi.hoisted(() => ({
  rebind: vi.fn(() => Promise.resolve()),
  resubscribe: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/notifications/start.ts", () => ({
  rebindDevice: start.rebind,
  resubscribeDevice: start.resubscribe,
  releaseThisDevice: vi.fn(),
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p") };
});

beforeEach(() => {
  usePwa.setState(usePwa.getInitialState(), true);
  start.rebind.mockClear();
  start.resubscribe.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

async function shell(state: "open" | "idle") {
  const bed = fakeRuntime(state);
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  const page = await renderShell("/");
  await settle();
  return { bed, page };
}

describe("the shell and push (M12R11, M12R12)", () => {
  it("reports presence once the connection is open", async () => {
    const { bed, page } = await shell("open");
    expect(bed.called("push.presence").map((call) => call.params)).toEqual([
      { focused: expect.any(Boolean) },
    ]);
    await page.unmount();
  });

  it("rebinds once per mount when the permission is granted, and loads nothing otherwise", async () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    const first = await shell("open");
    expect(start.rebind).toHaveBeenCalledTimes(1);
    first.bed.fake.setState("waiting");
    await settle();
    first.bed.fake.setState("open");
    await settle();
    expect(start.rebind).toHaveBeenCalledTimes(1);
    await first.page.unmount();

    vi.stubGlobal("Notification", { permission: "default" });
    start.rebind.mockClear();
    const second = await shell("open");
    expect(start.rebind).not.toHaveBeenCalled();
    await second.page.unmount();
  });

  it("registers the resubscribe handler on mount, runs it silently, and drops it at sign-out", async () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    const { page } = await shell("idle");
    const handler = usePwa.getState().resubscribeHandler;
    expect(handler).not.toBeNull();
    handler?.();
    await settle();
    expect(start.resubscribe).toHaveBeenCalledTimes(1);
    await page.unmount();
    expect(usePwa.getState().resubscribeHandler).toBeNull();
    const again = await shell("idle");
    expect(usePwa.getState().resubscribeHandler).not.toBeNull();
    await again.page.unmount();
  });
});
