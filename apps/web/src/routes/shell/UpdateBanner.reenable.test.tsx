// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { bannerKind, usePwa } from "../../stores/pwa.ts";
import { mount } from "../../testing/dom.ts";
import { settled } from "../../testing/pwa-env.ts";

const start = vi.hoisted(() => ({ enable: vi.fn() }));
const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../features/notifications/start.ts", () => ({ enableThisDevice: start.enable }));
vi.mock("../../runtime/index.ts", () => ({ getRuntime: () => ({ rpc: {} }), windowTimers: {} }));
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: ui.toast,
}));

import UpdateBanner from "./UpdateBanner.tsx";

beforeEach(() => {
  usePwa.setState(usePwa.getInitialState(), true);
  setLocale("fr");
  start.enable.mockReset();
  ui.toast.mockReset();
});

describe("the one-tap re-enable (M12R12)", () => {
  it("is shown for a device whose subscription was made with another key, after the update notice", () => {
    usePwa.getState().setNeedsReenable(true);
    expect(bannerKind(usePwa.getState())).toBe("reenable");
    usePwa.getState().markUpdateReady();
    expect(bannerKind(usePwa.getState())).toBe("update");
    usePwa.getState().hideUpdate();
    expect(bannerKind(usePwa.getState())).toBe("reenable");
    usePwa.getState().hideReenable();
    expect(bannerKind(usePwa.getState())).toBeNull();
  });

  it("asks in French and its button runs the enable flow from the click", async () => {
    usePwa.getState().setNeedsReenable(true);
    start.enable.mockImplementation(() => {
      usePwa.getState().setNeedsReenable(false);
      return Promise.resolve({ ok: true, id: "d" });
    });
    const page = await mount(<UpdateBanner />);
    expect(page.container.textContent).toContain("Réactiver les notifications");
    const button = [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Réactiver");
    button?.click();
    await settled();
    await settled();
    expect(start.enable).toHaveBeenCalledTimes(1);
    expect(page.container.innerHTML).toBe("");
    await page.unmount();
  });

  it("tells the owner when the enable flow fails, and keeps the banner", async () => {
    usePwa.getState().setNeedsReenable(true);
    start.enable.mockResolvedValue({ ok: false, reason: "denied" });
    const page = await mount(<UpdateBanner />);
    [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Réactiver")?.click();
    await settled();
    await settled();
    expect(ui.toast).toHaveBeenCalledTimes(1);
    expect(page.container.textContent).toContain("Réactiver les notifications");
    await page.unmount();
  });

  it("Plus tard hides it for this page load", async () => {
    usePwa.getState().setNeedsReenable(true);
    const page = await mount(<UpdateBanner />);
    [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Plus tard")?.click();
    await settled();
    expect(page.container.innerHTML).toBe("");
    expect(usePwa.getState().needsReenable).toBe(true);
    await page.unmount();
  });
});
