// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alerts,
  button,
  click,
  field,
  hasButton,
  mount,
  settle,
  typeInto,
  type Mounted,
} from "../../testing/dom.ts";
import type { AuthResult } from "./auth-api.ts";
import { LoginScreen } from "./LoginScreen.tsx";

const api = vi.hoisted(() => ({ login: vi.fn(), loginWithPasskey: vi.fn() }));
vi.mock("./auth-api.ts", () => api);

let page: Mounted | null = null;
const onDone = vi.fn();
const failed = (code: string, retryAfterSeconds: number | null = null): AuthResult => ({
  ok: false,
  code,
  retryAfterSeconds,
});

async function show(passkeysAvailable: boolean) {
  page = await mount(<LoginScreen passkeysAvailable={passkeysAvailable} onDone={onDone} />);
  return page.container;
}
async function signIn(container: HTMLElement) {
  await typeInto(field(container, "Username"), "ana");
  await typeInto(field(container, "Password"), "hunter2 hunter2");
  await click(button(container, "Sign in"));
  await settle();
}

beforeEach(() => {
  api.login.mockReset();
  api.loginWithPasskey.mockReset();
  onDone.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("LoginScreen", () => {
  it("offers the passkey first and the password form second (R22)", async () => {
    const container = await show(true);
    const passkey = button(container, "Sign in with a passkey");
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    expect(passkey.compareDocumentPosition(form as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("h1")?.textContent).toBe("Sign in");
  });

  it("shows no passkey button where passkeys are unavailable", async () => {
    const container = await show(false);
    expect(hasButton(container, "Sign in with a passkey")).toBe(false);
    expect(hasButton(container, "Sign in")).toBe(true);
  });

  it("keeps Sign in disabled until both fields are filled", async () => {
    const container = await show(false);
    expect(button(container, "Sign in").disabled).toBe(true);
    await typeInto(field(container, "Username"), "ana");
    expect(button(container, "Sign in").disabled).toBe(true);
    await typeInto(field(container, "Password"), "x");
    expect(button(container, "Sign in").disabled).toBe(false);
  });

  it("signs in with the typed credentials and tells the gate", async () => {
    api.login.mockResolvedValue({ ok: true });
    await signIn(await show(true));
    expect(api.login).toHaveBeenCalledExactlyOnceWith("ana", "hunter2 hunter2");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("says the username or password is wrong, in one sentence that names neither", async () => {
    api.login.mockResolvedValue(failed("unauthenticated"));
    const container = await show(true);
    await signIn(container);
    expect(alerts(container)).toEqual(["Wrong username or password."]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("shows the wait of a throttled password attempt", async () => {
    api.login.mockResolvedValue(failed("rate_limited", 9));
    const container = await show(true);
    await signIn(container);
    expect(alerts(container)).toEqual(["Too many attempts. Wait 9 s."]);
  });

  it("signs in with a passkey, without asking for a username or a password", async () => {
    api.loginWithPasskey.mockResolvedValue({ ok: true });
    const container = await show(true);
    await click(button(container, "Sign in with a passkey"));
    await settle();
    expect(api.loginWithPasskey).toHaveBeenCalledOnce();
    expect(api.login).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("reports a cancelled passkey prompt and lets the password form be used", async () => {
    api.loginWithPasskey.mockResolvedValue(failed("passkey_cancelled"));
    const container = await show(true);
    await click(button(container, "Sign in with a passkey"));
    await settle();
    expect(alerts(container)).toEqual(["The passkey prompt was cancelled."]);
    expect(button(container, "Sign in with a passkey").disabled).toBe(false);
  });
});
