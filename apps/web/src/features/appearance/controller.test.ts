// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportClientIssue } from "../../lib/report.ts";
import { RpcError } from "../../runtime/index.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { startAppearance, syncAccountAppearance } from "./controller.ts";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE } from "./model.ts";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const ocean = {
  id: "ocean",
  name: "Ocean",
  base: "night",
  roles: {
    bg: "#0e1626",
    surface: "#132033",
    text: "#e6edf7",
    agent: "#38bdf8",
    you: "#fb923c",
    attn: "#ec4899",
    ok: "#34d399",
    err: "#f87171",
  },
} as const;

let listeners: Array<() => void> = [];
let light = false;
let controller: { stop(): void } | null = null;
const root = document.documentElement;
// Lets the scripted server's promises and the document's follow-ups settle (microtasks only, not a sleep).
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

/** settings.get and settings.set answers per call; anything else is a test bug. */
function server(get: Array<() => unknown>, set: Array<() => unknown> = []) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    const step = (method === "settings.get" ? get : set).shift();
    if (!step) return new Promise(() => {}); // script exhausted: park, so a surplus call shows in the counts
    return step();
  });
  return {
    rpc: { call } as never,
    sets: () => calls.filter((c) => c.method === "settings.set").map((c) => c.params),
  };
}

beforeEach(() => {
  vi.mocked(reportClientIssue).mockClear();
  vi.useFakeTimers();
  localStorage.clear();
  root.removeAttribute("style");
  useAppearanceStore.setState({
    account: DEFAULT_ACCOUNT,
    device: DEFAULT_DEVICE,
    accountStatus: "local",
    deviceStored: true,
  });
  listeners = [];
  light = false;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return light && query.includes("light");
    },
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => (listeners = listeners.filter((l) => l !== fn)),
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  controller?.stop();
  controller = null;
  vi.useRealTimers();
  localStorage.clear();
});

describe("appearance controller", () => {
  it("applies the device settings at start and follows the system theme", () => {
    useAppearanceStore.getState().setDevice({ ...DEFAULT_DEVICE, density: "mixed" });
    controller = startAppearance(window);
    expect([root.dataset.density, root.dataset.theme]).toEqual(["mixed", "night"]);
    light = true;
    listeners.forEach((fn) => fn());
    expect(root.dataset.theme).toBe("day");
    controller.stop();
    controller = null;
    expect(listeners).toHaveLength(0);
  });

  it("re-applies when the store changes and caches the account for the boot script", () => {
    controller = startAppearance(window);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, mode: "day", grid: false });
    expect([root.dataset.theme, root.dataset.grid]).toEqual(["day", "off"]);
    expect(JSON.parse(localStorage.getItem("pap.appearance.boot") ?? "{}").mode).toBe("day");
  });

  it("removes the boot-set variables the app does not resolve on the first apply (M3-RT-11)", () => {
    root.style.setProperty("--bg", "#000000");
    root.style.setProperty("--app-viewport-height", "400px");
    controller = startAppearance(window);
    expect([
      root.style.getPropertyValue("--bg"),
      root.style.getPropertyValue("--app-viewport-height"),
    ]).toEqual(["", "400px"]);
  });

  it("takes the server's account once connected", async () => {
    controller = startAppearance(window);
    await syncAccountAppearance(
      server([() => ({ value: { ...DEFAULT_ACCOUNT, railPosition: "right" }, revision: 3 })]).rpc,
    );
    expect([root.dataset.rail, useAppearanceStore.getState().accountStatus]).toEqual(["right", "saved"]);
  });

  it("sends a change made before the sync after the load, merged over the server copy", async () => {
    controller = startAppearance(window);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    await vi.advanceTimersByTimeAsync(400);
    const s = server(
      [() => ({ value: { ...DEFAULT_ACCOUNT, railPosition: "right" }, revision: 3 })],
      [() => ({ revision: 4 })],
    );
    await syncAccountAppearance(s.rpc);
    await drain();
    expect(useAppearanceStore.getState().account).toEqual({
      ...DEFAULT_ACCOUNT,
      railPosition: "right",
      grid: false,
    });
    expect(s.sets()).toEqual([
      {
        key: "appearance",
        value: { ...DEFAULT_ACCOUNT, railPosition: "right", grid: false },
        baseRevision: 3,
      },
    ]);
  });

  it("never overwrites a change made while the server answer was on its way", async () => {
    controller = startAppearance(window);
    let answer: (v: unknown) => void = () => {};
    const s = server([() => new Promise((resolve) => (answer = resolve))], [() => ({ revision: 5 })]);
    const pending = syncAccountAppearance(s.rpc);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    answer({ value: { ...DEFAULT_ACCOUNT, grid: true, railPosition: "right" }, revision: 4 });
    await pending;
    await drain();
    expect(useAppearanceStore.getState().account).toEqual({
      ...DEFAULT_ACCOUNT,
      grid: false,
      railPosition: "right",
    });
    expect(s.sets()).toHaveLength(1);
  });

  it("after a load failure, shows it and saves nothing", async () => {
    controller = startAppearance(window);
    const s = server([() => Promise.reject(new Error("boom"))]);
    await syncAccountAppearance(s.rpc);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect([useAppearanceStore.getState().accountStatus, s.sets()]).toEqual(["load-error", []]);
    expect(reportClientIssue).toHaveBeenCalledWith("setting_load_failed");
  });

  it("keeps the local values for an older daemon and never saves to it", async () => {
    controller = startAppearance(window);
    const s = server([() => Promise.reject(new RpcError("unknown_method"))]);
    await syncAccountAppearance(s.rpc);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect([useAppearanceStore.getState().accountStatus, s.sets(), root.dataset.grid]).toEqual([
      "local",
      [],
      "off",
    ]);
  });

  it("marks device settings as page-only when storage refuses them", () => {
    const refuse = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      useAppearanceStore.getState().setDevice({ ...DEFAULT_DEVICE, motion: "none" });
    } finally {
      refuse.mockRestore();
    }
    expect(useAppearanceStore.getState().deviceStored).toBe(false);
    expect(useAppearanceStore.getState().device.motion).toBe("none");
    expect(reportClientIssue).toHaveBeenCalledWith("storage_refused");
  });

  it("reset keeps the custom themes and returns both previous scopes for Undo (owner R3-2)", () => {
    const account = { ...DEFAULT_ACCOUNT, customThemes: [ocean], darkTheme: "ocean", grid: false };
    useAppearanceStore.setState({ account, device: { ...DEFAULT_DEVICE, density: "comfortable" } });
    const previous = useAppearanceStore.getState().resetAll();
    expect(useAppearanceStore.getState().account).toEqual({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
    expect(useAppearanceStore.getState().device).toEqual(DEFAULT_DEVICE);
    expect(previous).toEqual({ account, device: { ...DEFAULT_DEVICE, density: "comfortable" } });
  });

  it("keeps this device's other fields when the server document lacks one field", async () => {
    controller = startAppearance(window);
    const partial: Record<string, unknown> = {
      ...DEFAULT_ACCOUNT,
      avatarStyle: "glyph",
      grid: false,
      toolDetail: "full",
    };
    delete partial.railPosition;
    await syncAccountAppearance(server([() => ({ value: partial, revision: 2 })]).rpc);
    expect(useAppearanceStore.getState().account).toEqual({
      ...DEFAULT_ACCOUNT,
      avatarStyle: "glyph",
      grid: false,
      toolDetail: "full",
    });
  });

  it("saves over a damaged row (value null, revision above 0) from that revision", async () => {
    controller = startAppearance(window);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    const s = server([() => ({ value: null, revision: 6 })], [() => ({ revision: 7 })]);
    await syncAccountAppearance(s.rpc);
    await drain();
    expect(s.sets()).toEqual([
      { key: "appearance", value: { ...DEFAULT_ACCOUNT, grid: false }, baseRevision: 6 },
    ]);
  });

  it("re-reads and retries once on a conflict, laying the changed field over the other device's copy", async () => {
    controller = startAppearance(window);
    const s = server(
      [
        () => ({ value: DEFAULT_ACCOUNT, revision: 1 }),
        () => ({ value: { ...DEFAULT_ACCOUNT, railPosition: "right" }, revision: 2 }),
      ],
      [() => Promise.reject(new RpcError("conflict")), () => ({ revision: 3 })],
    );
    await syncAccountAppearance(s.rpc);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    await vi.advanceTimersByTimeAsync(400);
    await drain();
    expect(s.sets()).toEqual([
      { key: "appearance", value: { ...DEFAULT_ACCOUNT, grid: false }, baseRevision: 1 },
      {
        key: "appearance",
        value: { ...DEFAULT_ACCOUNT, grid: false, railPosition: "right" },
        baseRevision: 2,
      },
    ]);
    expect([useAppearanceStore.getState().accountStatus, root.dataset.rail]).toEqual(["saved", "right"]);
  });

  it("seeds the inline variables on the first apply and copies the side bar colour to theme-color", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#14111d");
    document.head.append(meta);
    try {
      root.style.setProperty("--bg-side", "#123456");
      useAppearanceStore.setState({
        account: { ...DEFAULT_ACCOUNT, customThemes: [ocean], darkTheme: "ocean" },
      });
      controller = startAppearance(window);
      // mix(bg, surface, 0.35) of the Ocean roles; the boot-set #123456 is replaced, not kept.
      expect(root.style.getPropertyValue("--bg-side")).toBe("#101a2b");
      expect(meta.getAttribute("content")).toBe("#101a2b");
    } finally {
      meta.remove();
    }
  });

  it("applies the appearance when blocked storage throws on access", () => {
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      controller = startAppearance(window);
      expect(() =>
        useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false }),
      ).not.toThrow();
      expect(root.dataset.grid).toBe("off");
      expect(reportClientIssue).toHaveBeenCalledWith("boot_cache_refused");
    } finally {
      blocked.mockRestore();
    }
  });
});
