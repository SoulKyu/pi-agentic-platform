// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStatus } from "../features/auth/auth-api.ts";
import type { Runtime } from "../runtime/index.ts";
import { alerts, hasButton, mount, settle, text, type Mounted } from "../testing/dom.ts";
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
vi.mock("../features/auth/auth-api.ts", () => api);
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
});
