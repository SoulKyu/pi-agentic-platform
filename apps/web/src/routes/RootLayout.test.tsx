// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStatus } from "../features/auth/auth-api.ts";
import type { Runtime } from "../runtime/index.ts";
import { alerts, button, click, hasButton, mount, settle, text, type Mounted } from "../testing/dom.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { RootLayout } from "./RootLayout.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const api = vi.hoisted(() => ({
  fetchAuthStatus: vi.fn(),
  login: vi.fn(),
  loginWithPasskey: vi.fn(),
  setupOwner: vi.fn(),
  logout: vi.fn(),
  registerPasskey: vi.fn(),
}));
const browser = vi.hoisted(() => ({ webauthn: true }));
vi.mock("../features/auth/auth-api.ts", () => api);
vi.mock("../features/auth/passkey-support.ts", () => ({
  passkeysUsable: (serverAllows: boolean) => serverAllows && browser.webauthn,
}));
vi.mock("../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Outlet: () => createElement("p", { "data-screen": "outlet" }, "the current route") };
});

let bed: ReturnType<typeof fakeRuntime>;
let start: ReturnType<typeof vi.spyOn>;
let stop: ReturnType<typeof vi.spyOn>;
let page: Mounted | null = null;

const status = (overrides: Partial<AuthStatus>): AuthStatus => ({
  setupRequired: false,
  authenticated: true,
  username: "ana",
  passkeysAvailable: true,
  ...overrides,
});

async function show(first: AuthStatus | Error) {
  api.fetchAuthStatus.mockImplementation(() =>
    first instanceof Error ? Promise.reject(first) : Promise.resolve(first),
  );
  page = await mount(<RootLayout />);
  await settle();
  return page.container;
}

beforeEach(() => {
  bed = fakeRuntime("idle");
  current.runtime = bed.runtime;
  start = vi.spyOn(bed.runtime.connection, "start");
  stop = vi.spyOn(bed.runtime.connection, "stop");
  api.fetchAuthStatus.mockReset();
  browser.webauthn = true;
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("RootLayout", () => {
  it("shows the loading line until the server has said who this is", async () => {
    api.fetchAuthStatus.mockReturnValue(new Promise(() => {}));
    page = await mount(<RootLayout />);
    expect(text(page.container)).toBe("Loading…");
  });

  it("opens the owner setup on a fresh server, with no connection", async () => {
    const container = await show(status({ setupRequired: true, authenticated: false, username: null }));
    expect(container.querySelector("h1")?.textContent).toBe("Create the owner account");
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it("opens the sign-in screen when signed out, with no connection", async () => {
    const container = await show(status({ authenticated: false, username: null }));
    expect(container.querySelector("h1")?.textContent).toBe("Sign in");
    expect(hasButton(container, "Sign in with a passkey")).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it("shows the account bar and the route, and connects, once signed in", async () => {
    const container = await show(status({}));
    expect(text(container)).toContain("pap · ana");
    expect(container.querySelector('[data-screen="outlet"]')).not.toBeNull();
    expect(start).toHaveBeenCalledOnce();
  });

  it("asks again who this is when the server ends the session, and drops to sign-in", async () => {
    const container = await show(status({}));
    expect(container.querySelector('[data-screen="outlet"]')).not.toBeNull();
    api.fetchAuthStatus.mockResolvedValue(status({ authenticated: false, username: null }));
    await act(async () => {
      bed.fake.setState("signed-out");
    });
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("Sign in");
    expect(container.querySelector('[data-screen="outlet"]')).toBeNull();
    expect(stop).toHaveBeenCalled();
  });

  it("warns that the page is out of date, and that it is reconnecting", async () => {
    const container = await show(status({}));
    await act(async () => {
      bed.fake.setState("waiting");
    });
    const statuses = [...container.querySelectorAll('[role="status"]')].map((element) => element.textContent);
    expect(statuses).toContain("Reconnecting…");
    await act(async () => {
      bed.fake.setState("outdated");
    });
    expect(alerts(container)).toEqual(["A new version of pap is available. Reload the page."]);
  });

  it("says the server is unreachable when the status cannot be read", async () => {
    const container = await show(new TypeError("Failed to fetch"));
    expect(alerts(container)).toEqual(["pap is unreachable right now."]);
  });

  it("says why when the server answered the status with an error code, not that it is unreachable", async () => {
    const container = await show(Object.assign(new Error("auth status unavailable"), { code: "read_only" }));
    expect(alerts(container)).toEqual(["The database was written by a newer pap and is read-only."]);
    expect(hasButton(container, "Retry")).toBe(true);
  });

  it("shows no passkey button where the browser cannot use passkeys, though the server offers them", async () => {
    browser.webauthn = false;
    const container = await show(status({ authenticated: false, username: null }));
    expect(hasButton(container, "Sign in with a passkey")).toBe(false);
    await page?.unmount();
    page = null;
    const signedIn = await show(status({}));
    expect(hasButton(signedIn, "Add a passkey")).toBe(false);
  });

  it("offers a Retry when the status cannot be read, and goes on once it can", async () => {
    const container = await show(new TypeError("Failed to fetch"));
    expect(alerts(container)).toEqual(["pap is unreachable right now."]);
    api.fetchAuthStatus.mockResolvedValue(status({ authenticated: false, username: null }));
    await click(button(container, "Retry"));
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("Sign in");
    expect(hasButton(container, "Retry")).toBe(false);
  });

  it("stays on the error with its Retry when the retry fails too", async () => {
    const container = await show(new TypeError("Failed to fetch"));
    await click(button(container, "Retry"));
    await settle();
    expect(alerts(container)).toEqual(["pap is unreachable right now."]);
    expect(api.fetchAuthStatus).toHaveBeenCalledTimes(2);
    expect(hasButton(container, "Retry")).toBe(true);
  });

  it("retries by itself when the browser comes back online, but only from the error", async () => {
    const container = await show(new TypeError("Failed to fetch"));
    api.fetchAuthStatus.mockResolvedValue(status({}));
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect(container.querySelector('[data-screen="outlet"]')).not.toBeNull();
    const calls = api.fetchAuthStatus.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect(api.fetchAuthStatus).toHaveBeenCalledTimes(calls);
  });
});
