// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { backoffDelay } from "../../runtime/connection.ts";
import { connectionBed, flush } from "../../runtime/testing.ts";
import { deviceStorage, loadDraft, saveDraft } from "../../stores/drafts.ts";
import { click, mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ConnectionBanner } from "./ConnectionBanner.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1_000_000);
  switchLocale("fr");
});
afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  switchLocale("en");
});

function setup(state: Parameters<typeof fakeRuntime>[0], retryAt: number | null) {
  const bed = fakeRuntime(state);
  bed.fake.setRetryAt(retryAt);
  current.runtime = bed.runtime;
  return { ...bed, retry: bed.fake.connection.retry };
}
/** What a screen reader gets from the live region: the text without the aria-hidden nodes. */
const announced = () => {
  const region = (document.querySelector('[data-slot="banner"]') as HTMLElement).cloneNode(
    true,
  ) as HTMLElement;
  for (const hidden of region.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return region.textContent;
};
const text = () => document.body.textContent ?? "";
const button = () => document.querySelector("button") as HTMLButtonElement | null;

describe("ConnectionBanner", () => {
  it("banner.countdown: says the daemon is silent, counts down each second and keeps the drafts line", async () => {
    setup("waiting", 1_008_000);
    await mount(<ConnectionBanner />);
    expect(text()).toContain("Le daemon ne répond plus.");
    expect(text()).toContain("Nouvelle tentative dans 8 s");
    expect(text()).toContain("Vos brouillons restent sur cet appareil.");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(text()).toContain("Nouvelle tentative dans 7 s");
    await act(async () => {
      vi.advanceTimersByTime(7_000);
    });
    expect(text()).toContain("Nouvelle tentative dans 0 s");
  });

  it("banner.countdown: the Réessayer button asks the supervisor to retry", async () => {
    const bed = setup("waiting", 1_008_000);
    await mount(<ConnectionBanner />);
    expect(button()?.textContent).toBe("Réessayer");
    expect(button()?.disabled).toBe(false);
    await click(button() as HTMLButtonElement);
    expect(bed.retry).toHaveBeenCalledOnce();
  });

  it("banner.announce-stable: the live region text does not change while the seconds tick", async () => {
    setup("waiting", 1_008_000);
    await mount(<ConnectionBanner />);
    const before = announced();
    expect(before).toContain("Le daemon ne répond plus.");
    expect(before).not.toMatch(/\d/);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(text()).toContain("Nouvelle tentative dans 5 s");
    expect(announced()).toBe(before);
  });

  it("banner.probe-window: Réessayer is disabled until a retry is armed, with no countdown shown", async () => {
    const bed = setup("waiting", null);
    await mount(<ConnectionBanner />);
    expect(text()).toContain("Le daemon ne répond plus.");
    expect(text()).not.toContain("Nouvelle tentative");
    expect(button()?.disabled).toBe(true);
    bed.fake.setRetryAt(1_008_000);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(button()?.disabled).toBe(false);
    expect(text()).toContain("Nouvelle tentative dans 7 s");
  });

  it("banner.countdown: the button is disabled while connecting, and the banner leaves once open", async () => {
    const bed = setup("waiting", 1_008_000);
    await mount(<ConnectionBanner />);
    await act(async () => bed.fake.setState("connecting"));
    expect(text()).toContain("Reconnexion…");
    expect(button()?.disabled).toBe(true);
    await act(async () => bed.fake.setState("open"));
    expect(document.body.querySelector('[data-slot="banner"]')).toBeNull();
  });

  it("shows nothing on a first connection, and arms no tick outside the waiting state", async () => {
    setup("connecting", null);
    await mount(<ConnectionBanner />);
    expect(document.body.querySelector('[data-slot="banner"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drafts.survive-reconnect: the composer draft is untouched by waiting and open, and read back after a reload", async () => {
    vi.useRealTimers(); // the bed's flush() needs real timers
    const bed = connectionBed();
    bed.connection.start();
    bed.hello();
    saveDraft(localStorage, "s1", "half a thought");
    bed.latest().close();
    await flush();
    expect(bed.connection.state).toBe("waiting");
    expect(loadDraft(localStorage, "s1")).toBe("half a thought");
    bed.advance(backoffDelay(0, 0.5));
    bed.hello();
    expect(bed.connection.state).toBe("open");
    expect(loadDraft(localStorage, "s1")).toBe("half a thought");
    expect(loadDraft(deviceStorage(), "s1")).toBe("half a thought");
  });
});
