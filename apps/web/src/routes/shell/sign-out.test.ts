import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  logout: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../../features/auth/auth-api.ts", () => ({ logout: mocks.logout }));
vi.mock("../../features/notifications/start.ts", () => ({ releaseThisDevice: mocks.release }));
vi.mock("../../runtime/index.ts", () => ({
  getRuntime: () => ({ rpc: {} }),
  windowTimers: {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clear: (id: number) => clearTimeout(id),
  },
}));
vi.mock("@pap/ui", () => ({ toast: vi.fn() }));

import { signOut } from "./sign-out.ts";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  mocks.order.length = 0;
  mocks.logout.mockImplementation(() => {
    mocks.order.push("logout");
    return Promise.resolve();
  });
  mocks.release.mockImplementation(() => {
    mocks.order.push("release");
    return Promise.resolve();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("signOut and this device's push subscription (M12R12)", () => {
  it("releases the device first (the session must still be live), then logs out", async () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    const done = vi.fn();
    signOut(done);
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(mocks.order).toEqual(["release", "logout"]);
  });

  it("does not load the push code when the permission is not granted", async () => {
    vi.stubGlobal("Notification", { permission: "default" });
    const done = vi.fn();
    signOut(done);
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(mocks.order).toEqual(["logout"]);
  });

  it("logs out even when the release fails", async () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    mocks.release.mockRejectedValueOnce(new Error("x"));
    const done = vi.fn();
    signOut(done);
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(mocks.order).toEqual(["logout"]);
  });

  it("logs out after 3 s when the release never answers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Notification", { permission: "granted" });
    mocks.release.mockImplementationOnce(() => new Promise(() => {}));
    const done = vi.fn();
    signOut(done);
    await flush();
    expect(mocks.order).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(done).toHaveBeenCalled();
    expect(mocks.order).toEqual(["logout"]);
  });
});
