// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStatus } from "../features/auth/auth-api.ts";
import type { Runtime } from "../runtime/index.ts";
import { mount, settle, type Mounted } from "../testing/dom.ts";
import { PROJECT_BOX } from "../testing/previews-fixtures.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { RootLayout } from "./RootLayout.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const api = vi.hoisted(() => ({ fetchAuthStatus: vi.fn() }));
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
vi.mock("./preview/PreviewWindow.tsx", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: { box: { kind: string; id: string }; name: string }) =>
      createElement("p", { "data-preview-window": "" }, `${props.box.kind}:${props.box.id}/${props.name}`),
  };
});

const signedIn = (authenticated: boolean): AuthStatus => ({
  setupRequired: false,
  authenticated,
  username: authenticated ? "ana" : null,
  role: "owner",
  passkeysAvailable: false,
});

let page: Mounted | null = null;
beforeEach(() => {
  current.runtime = fakeRuntime("idle").runtime;
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  window.history.replaceState(null, "", "/");
});

async function open(path: string, authenticated: boolean) {
  window.history.replaceState(null, "", path);
  api.fetchAuthStatus.mockResolvedValue(signedIn(authenticated));
  page = await mount(<RootLayout />);
  await settle();
  await vi.waitFor(() => expect(page?.container.querySelector("main, p, h1")).not.toBeNull());
  return page.container;
}

describe("RootLayout and the preview window (UX2-R79)", () => {
  it("renders the window instead of the shell once signed in", async () => {
    const container = await open(`/preview/project:${PROJECT_BOX.id}/site`, true);
    await vi.waitFor(() => expect(container.querySelector("[data-preview-window]")).not.toBeNull());
    expect(container.querySelector("[data-preview-window]")?.textContent).toBe(
      `project:${PROJECT_BOX.id}/site`,
    );
    expect(container.querySelector('[data-screen="shell"]')).toBeNull();
  });

  it("signed out, the path shows the sign-in, not the window", async () => {
    const container = await open(`/preview/project:${PROJECT_BOX.id}/site`, false);
    expect(container.querySelector("h1")?.textContent).toBe("Sign in");
    expect(container.querySelector("[data-preview-window]")).toBeNull();
  });

  it("any other path keeps the shell", async () => {
    const container = await open("/tasks", true);
    expect(container.querySelector('[data-screen="shell"]')).not.toBeNull();
    expect(container.querySelector("[data-preview-window]")).toBeNull();
  });
});
