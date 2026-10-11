// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alerts, button, click, field, mount, settle, typeInto, type Mounted } from "../../testing/dom.ts";
import { SetupScreen } from "./SetupScreen.tsx";

const api = vi.hoisted(() => ({ setupOwner: vi.fn() }));
vi.mock("./auth-api.ts", () => api);

let page: Mounted | null = null;
const onDone = vi.fn();

async function show(hash: string) {
  window.history.replaceState(null, "", `/setup${hash}`);
  page = await mount(<SetupScreen onDone={onDone} />);
  return page.container;
}
async function fill(container: HTMLElement, password: string) {
  await typeInto(field(container, "Username"), "ana");
  await typeInto(field(container, "Password"), password);
}

beforeEach(() => {
  api.setupOwner.mockReset();
  onDone.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("SetupScreen", () => {
  it("sends the one-time token of the address with the account", async () => {
    api.setupOwner.mockResolvedValue({ ok: true });
    const container = await show("#token=tok-123");
    await fill(container, "a long enough password");
    await click(button(container, "Create account"));
    await settle();
    expect(api.setupOwner).toHaveBeenCalledExactlyOnceWith("tok-123", "ana", "a long enough password");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("removes the token from the address once the account exists", async () => {
    api.setupOwner.mockResolvedValue({ ok: true });
    const container = await show("#token=tok-123");
    await fill(container, "a long enough password");
    await click(button(container, "Create account"));
    await settle();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
  });

  it("asks for the setup link when the address carries no token, and cannot be submitted", async () => {
    const container = await show("");
    expect(alerts(container)).toEqual(["Open the setup link printed in the server log."]);
    await fill(container, "a long enough password");
    expect(button(container, "Create account").disabled).toBe(true);
  });

  it("wants at least 12 characters", async () => {
    const container = await show("#token=tok");
    await fill(container, "elevenchars");
    expect(button(container, "Create account").disabled).toBe(true);
    await typeInto(field(container, "Password"), "twelve chars");
    expect(button(container, "Create account").disabled).toBe(false);
  });

  it("points back at the setup link when the server refuses the token", async () => {
    api.setupOwner.mockResolvedValue({ ok: false, code: "unauthenticated", retryAfterSeconds: null });
    const container = await show("#token=stale");
    await fill(container, "a long enough password");
    await click(button(container, "Create account"));
    await settle();
    expect(alerts(container)).toEqual(["Open the setup link printed in the server log."]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("states the username rule, and keeps Create account off for a name the server would refuse", async () => {
    const container = await show("#token=tok");
    expect(container.textContent).toContain("Letters, digits, dot, dash and underscore; up to 64.");
    for (const name of ["ana smith", "ana@example.com", "é", "x".repeat(65)]) {
      await typeInto(field(container, "Username"), name);
      await typeInto(field(container, "Password"), "a long enough password");
      expect(button(container, "Create account").disabled, name).toBe(true);
    }
    for (const name of ["ana", "a.b-c_d", "x".repeat(64)]) {
      await typeInto(field(container, "Username"), name);
      expect(button(container, "Create account").disabled, name).toBe(false);
    }
  });
});
