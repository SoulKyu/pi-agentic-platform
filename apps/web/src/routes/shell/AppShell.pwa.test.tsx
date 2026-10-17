// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { usePwa } from "../../stores/pwa.ts";
import { settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import "./UpdateBanner.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p") };
});

beforeEach(() => {
  usePwa.setState(usePwa.getInitialState(), true);
});

describe("the shell and the pwa store", () => {
  it("shows the update banner in a lazy slot once an update is ready", async () => {
    const bed = fakeRuntime("idle");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    current.runtime = bed.runtime;
    const page = await renderShell("/");
    await settle();
    expect(page.container.querySelector("[data-update-banner]")).toBeNull();
    usePwa.getState().markUpdateReady();
    await settle();
    expect(page.container.querySelector("[data-update-banner]")).not.toBeNull();
    await page.unmount();
  });

  it("sign-out resets the store (MC34)", async () => {
    const bed = fakeRuntime("idle");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    current.runtime = bed.runtime;
    const page = await renderShell("/");
    await settle();
    usePwa.getState().setNeedsReenable(true);
    usePwa.getState().onOpen(() => {});
    await page.unmount();
    expect(usePwa.getState().needsReenable).toBe(false);
    expect(usePwa.getState().openHandler).toBeNull();
  });
});
