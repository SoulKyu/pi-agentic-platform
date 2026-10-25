// @vitest-environment happy-dom
import { createMemoryHistory, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStatus } from "../features/auth/auth-api.ts";
import type { Runtime } from "../runtime/index.ts";
import { button, click, field, mount, settle, typeInto, type Mounted } from "../testing/dom.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { buildRouteTree, createAppRouter } from "./router.tsx";
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
vi.mock("../features/auth/passkey-support.ts", () => ({ passkeysUsable: () => false }));
vi.mock("../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./shell/AppShell.tsx", async () => {
  const { createElement } = await import("react");
  return { AppShell: () => createElement("p", { "data-screen": "shell" }, "shell") };
});

const ID = "abcdefghijklmnopqrstuv";
const status = (over: Partial<AuthStatus>): AuthStatus => ({
  setupRequired: false,
  authenticated: true,
  username: "ana",
  role: "owner",
  passkeysAvailable: false,
  ...over,
});
let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;
let router: AnyRouter;

beforeEach(() => {
  bed = fakeRuntime("idle");
  current.runtime = bed.runtime;
  api.fetchAuthStatus.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("a notification opened while signed out", () => {
  it("shows the login on /n/<id>, keeps the address, and the shell takes over there after sign-in", async () => {
    api.fetchAuthStatus.mockResolvedValue(status({ authenticated: false, username: null }));
    router = createAppRouter(
      buildRouteTree(RootLayout),
      createMemoryHistory({ initialEntries: [`/n/${ID}`] }),
    );
    page = await mount(<RouterProvider router={router} />);
    await settle();
    expect(page.container.querySelector("h1")?.textContent).toBe("Sign in");
    expect(page.container.querySelector('[data-screen="shell"]')).toBeNull();
    expect(router.state.location.pathname).toBe(`/n/${ID}`);
    expect(bed.called("push.open")).toEqual([]);
    api.login.mockResolvedValue({ ok: true });
    api.fetchAuthStatus.mockResolvedValue(status({}));
    await typeInto(field(page.container, "Username"), "ana");
    await typeInto(field(page.container, "Password"), "hunter2 hunter2");
    await click(button(page.container, "Sign in"));
    await settle();
    expect(page.container.querySelector('[data-screen="shell"]')).not.toBeNull();
    expect(router.state.location.pathname).toBe(`/n/${ID}`);
  });
});
