// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { createRpcClient } from "../../runtime/rpc.ts";
import { fakeConnection } from "../../runtime/testing.ts";
import { button, click, field, mount, settle, text, typeInto, type Mounted } from "../../testing/dom.ts";
import { overviewOf } from "../../features/models/models-bed.tsx";
import { RootLayout } from "../RootLayout.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const api = vi.hoisted(() => ({
  fetchAuthStatus: vi.fn(),
  setupOwner: vi.fn(),
  registerPasskey: vi.fn(),
  confirmPassword: vi.fn(),
}));
vi.mock("../../features/auth/auth-api.ts", () => api);
vi.mock("../../features/auth/passkey-support.ts", () => ({ passkeysUsable: () => true }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

// The real rpc client over a connection that only opens when the page starts it: a call before that is `offline`.
function realRpcRuntime() {
  const fake = fakeConnection("idle");
  const started = vi.fn(() => fake.setState("open"));
  fake.connection.start = started;
  const send = fake.connection.send;
  fake.connection.send = (frame) => {
    const ok = send(frame);
    const { id, method } = frame as { id: number; method: string };
    if (ok && method === "models.overview")
      queueMicrotask(() => fake.deliver({ id, ok: true, result: overviewOf() }));
    return ok;
  };
  const rpc = createRpcClient(fake.connection, {
    newCommandId: () => "cmd",
    timers: { set: () => 0, clear: () => {} },
  });
  return { started, runtime: { connection: fake.connection, rpc } as unknown as Runtime };
}

describe("first run on a real rpc client", () => {
  it("opens the socket once the account exists, so the Pi step can read the providers", async () => {
    const bed = realRpcRuntime();
    current.runtime = bed.runtime;
    api.setupOwner.mockResolvedValue({ ok: true });
    api.fetchAuthStatus.mockResolvedValue({
      setupRequired: true,
      authenticated: false,
      username: null,
      passkeysAvailable: true,
    });
    window.history.replaceState(null, "", "/setup#token=tok");
    page = await mount(<RootLayout />);
    await vi.waitFor(() => expect(page?.container.querySelector("h1")).not.toBeNull(), { timeout: 5000 });
    expect(bed.started).not.toHaveBeenCalled();
    await typeInto(field(page.container, "Username"), "ana");
    await typeInto(field(page.container, "Password"), "a long enough password");
    await click(button(page.container, "Create account"));
    await settle();
    await click(button(page.container, "Skip"));
    await vi.waitFor(() => expect(text(page?.container as HTMLElement)).toContain("Ready"), {
      timeout: 5000,
    });
    expect(bed.started).toHaveBeenCalledOnce();
  });
});
