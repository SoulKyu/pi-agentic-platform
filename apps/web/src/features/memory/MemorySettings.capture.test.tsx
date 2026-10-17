// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { mount, settle } from "../../testing/dom.ts";
import { preloadMenu } from "../../testing/menu.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { MemorySettings } from "./MemorySettings.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(async () => {
  await preloadMenu();
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["memory.status"] = () => ({
    installed: true,
    watcher: "fresh",
    checkedAt: Date.now() - 125_000,
    lastCaptureError: null,
    lastCaptureAt: null,
  });
  bed.handlers["memory.scopes"] = () => ({ scopes: [{ scope: { kind: "user" }, label: null }] });
  bed.handlers["memory.list"] = () => ({ items: [], journal: [] });
  bed.handlers["memory.staged"] = () => ({ facts: [] });
});
afterEach(() => setLocale("en"));

const show = async () => {
  const page = await mount(<MemorySettings />);
  await settle();
  return page;
};

describe("pi-mem0's last capture failure", () => {
  it("shows pi-mem0's last capture failure as plain text, hidden characters removed, 300 characters at most", async () => {
    bed.handlers["memory.status"] = () => ({
      installed: true,
      watcher: "fresh",
      checkedAt: Date.now() - 125_000,
      lastCaptureError: "<b>boom</b>\u202e " + "x".repeat(280),
      lastCaptureAt: "2026-10-16T07:00:00.000Z",
    });
    const page = await show();
    const block = page.container.querySelector('[data-slot="memory-capture-error"]') as HTMLElement;
    expect(block.textContent).toContain("The last capture failed");
    expect(block.textContent).toContain("<b>boom</b> xxx");
    expect(block.textContent).not.toContain("\u202e");
    expect(block.querySelector("b")).toBeNull();
  });

  it("shows when the last capture was, next to the failure, in the viewer's language", async () => {
    const at = "2026-10-16T07:00:00.000Z";
    bed.handlers["memory.status"] = () => ({
      installed: true,
      watcher: "fresh",
      checkedAt: Date.now() - 125_000,
      lastCaptureError: "boom",
      lastCaptureAt: at,
    });
    const page = await show();
    const block = () => page.container.querySelector('[data-slot="memory-capture-error"]') as HTMLElement;
    expect(block().textContent).toContain(`Since ${new Date(at).toLocaleString("en")}`);
    const shown = block().textContent ?? "";
    expect(shown.indexOf("Since")).toBeLessThan(shown.indexOf("The last capture failed"));
    await page.unmount();
    setLocale("fr");
    const french = await show();
    const frBlock = french.container.querySelector('[data-slot="memory-capture-error"]') as HTMLElement;
    expect(frBlock.textContent).toContain(`Depuis le ${new Date(at).toLocaleString("fr")}`);
  });

  it("leaves the time out when pi-mem0 gave none, or one that is not a date", async () => {
    for (const lastCaptureAt of [null, "not a date"]) {
      bed.handlers["memory.status"] = () => ({
        installed: true,
        watcher: "fresh",
        checkedAt: Date.now() - 125_000,
        lastCaptureError: "boom",
        lastCaptureAt,
      });
      const page = await show();
      const block = page.container.querySelector('[data-slot="memory-capture-error"]') as HTMLElement;
      expect(block.textContent).not.toMatch(/since|depuis/i);
      await page.unmount();
    }
  });

  it("shows no capture failure when pi-mem0 wrote none", async () => {
    const page = await show();
    expect(page.container.querySelector('[data-slot="memory-capture-error"]')).toBeNull();
  });
});
