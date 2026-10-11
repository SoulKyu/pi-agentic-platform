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
  text,
  typeInto,
  type Mounted,
} from "../../testing/dom.ts";
import { AddPasskey } from "./AddPasskey.tsx";
import type { AuthResult } from "./auth-api.ts";

const api = vi.hoisted(() => ({ registerPasskey: vi.fn() }));
vi.mock("./auth-api.ts", () => api);

let page: Mounted | null = null;
const props = { onAdded: vi.fn(), onSignedOut: vi.fn() };

async function open() {
  page = await mount(<AddPasskey {...props} />);
  await click(button(page.container, "Add a passkey"));
  return page.container;
}
async function submitWith(container: HTMLElement, password: string, result: AuthResult) {
  api.registerPasskey.mockResolvedValue(result);
  await typeInto(field(container, "Password"), password);
  await click(button(container, "Add a passkey"));
  await settle();
}

beforeEach(() => {
  api.registerPasskey.mockReset();
  props.onAdded.mockReset();
  props.onSignedOut.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("AddPasskey", () => {
  it("shows one button, and asks for the password before anything else happens", async () => {
    page = await mount(<AddPasskey {...props} />);
    expect(page.container.querySelectorAll("button")).toHaveLength(1);
    expect(page.container.querySelector("input")).toBeNull();
    await click(button(page.container, "Add a passkey"));
    expect(field(page.container, "Password").type).toBe("password");
    expect(text(page.container)).toContain("Enter your password to add a passkey.");
    expect(api.registerPasskey).not.toHaveBeenCalled();
    // The trigger gives way to the form, so "Add a passkey" names exactly one button at any moment.
    expect(page.container.querySelectorAll("button")).toHaveLength(2);
    expect(hasButton(page.container, "Cancel")).toBe(true);
  });

  it("will not submit an empty password", async () => {
    const container = await open();
    expect(button(container, "Add a passkey").disabled).toBe(true);
  });

  it("registers with the password typed, then closes and reports the addition", async () => {
    const container = await open();
    await submitWith(container, "correct horse battery", { ok: true });
    expect(api.registerPasskey).toHaveBeenCalledExactlyOnceWith("correct horse battery");
    expect(props.onAdded).toHaveBeenCalledOnce();
    expect(container.querySelector("input")).toBeNull();
    expect(hasButton(container, "Add a passkey")).toBe(true);
  });

  it("says the password is incorrect and keeps the form open for another try", async () => {
    const container = await open();
    await submitWith(container, "wrong", { ok: false, code: "password_incorrect", retryAfterSeconds: null });
    expect(alerts(container)).toEqual(["Password incorrect."]);
    expect(field(container, "Password").value).toBe("wrong");
    expect(props.onAdded).not.toHaveBeenCalled();
    expect(props.onSignedOut).not.toHaveBeenCalled();
  });

  it("shows the wait of a throttled attempt", async () => {
    const container = await open();
    await submitWith(container, "wrong", { ok: false, code: "rate_limited", retryAfterSeconds: 12 });
    expect(alerts(container)).toEqual(["Too many attempts. Wait 12 s."]);
  });

  it("hands over to sign-in when the session itself ended", async () => {
    const container = await open();
    await submitWith(container, "right", { ok: false, code: "unauthenticated", retryAfterSeconds: null });
    expect(props.onSignedOut).toHaveBeenCalledOnce();
    expect(alerts(container)).toEqual([]);
  });

  it("reports a cancelled authenticator prompt", async () => {
    const container = await open();
    await submitWith(container, "right", { ok: false, code: "passkey_cancelled", retryAfterSeconds: null });
    expect(alerts(container)).toEqual(["The passkey prompt was cancelled."]);
  });

  it("cancels back to the single button and forgets the password", async () => {
    const container = await open();
    await typeInto(field(container, "Password"), "secret");
    await click(button(container, "Cancel"));
    expect(container.querySelector("input")).toBeNull();
    await click(button(container, "Add a passkey"));
    expect(field(container, "Password").value).toBe("");
  });
});
