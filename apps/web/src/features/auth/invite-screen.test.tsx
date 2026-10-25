// @vitest-environment happy-dom
import { act, useEffect } from "react";
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
import type { AuthResult } from "./auth-api.ts";

const api = vi.hoisted(() => ({
  inviteInfo: vi.fn(),
  acceptInvite: vi.fn(),
  fetchAuthStatus: vi.fn(),
  registerPasskey: vi.fn(),
  login: vi.fn(),
  loginWithPasskey: vi.fn(),
}));
vi.mock("./auth-api.ts", () => api);

const { InviteScreen } = await import("./InviteScreen.tsx");
const { LoginScreen } = await import("./LoginScreen.tsx");

let page: Mounted | null = null;
const onDone = vi.fn();
const failed = (code: string): AuthResult => ({ ok: false, code, retryAfterSeconds: null });

async function show(token: string | null = "tok-abcdefghijklmnop", signedInAs: string | null = null) {
  page = await mount(<InviteScreen token={token} signedInAs={signedInAs} onDone={onDone} />);
  await settle();
  return page.container;
}
async function fill(container: HTMLElement) {
  await typeInto(field(container, "Username"), "bob");
  await typeInto(field(container, "Password"), "a long enough password");
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  onDone.mockReset();
  api.inviteInfo.mockResolvedValue({ ok: true, inviter: "ana", expiresAt: 1 });
  api.fetchAuthStatus.mockResolvedValue({ passkeysAvailable: false });
});
afterEach(async () => {
  vi.useRealTimers();
  await page?.unmount();
  page = null;
});

describe("InviteScreen", () => {
  it("shows the inviter, creates the account, then offers a passkey", async () => {
    api.acceptInvite.mockResolvedValue({ ok: true });
    const container = await show();
    expect(text(container)).toContain("ana invites you.");
    await fill(container);
    await click(button(container, "Create my account"));
    await settle();
    expect(api.acceptInvite).toHaveBeenCalledExactlyOnceWith(
      "tok-abcdefghijklmnop",
      "bob",
      "a long enough password",
    );
    expect(text(container)).toContain("Add a passkey");
    expect(onDone).not.toHaveBeenCalled();
    await click(button(container, "Continue"));
    expect(onDone).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe("/");
  });

  it("an invalid invitation shows the invite_invalid sentence and no form", async () => {
    api.inviteInfo.mockResolvedValue(failed("invite_invalid"));
    const container = await show();
    expect(alerts(container)).toEqual([
      "This invitation link does not work: it expired, was used, or was revoked. Ask for a new one.",
    ]);
    expect(container.querySelector("form")).toBeNull();
    expect(api.acceptInvite).not.toHaveBeenCalled();
  });

  it("an address without a token shows the same sentence and asks the server nothing", async () => {
    const container = await show(null);
    expect(alerts(container)[0]).toContain("This invitation link does not work");
    expect(api.inviteInfo).not.toHaveBeenCalled();
  });

  it("a taken username shows the username_taken sentence and keeps the form", async () => {
    api.acceptInvite.mockResolvedValue(failed("username_taken"));
    const container = await show();
    await fill(container);
    await click(button(container, "Create my account"));
    await settle();
    expect(alerts(container)).toEqual([
      "This username is taken. Choose another; your invitation is still valid.",
    ]);
    expect(field(container, "Username").value).toBe("bob");
    expect(button(container, "Create my account").disabled).toBe(false);
  });

  it('a signed-in visitor sees "Signed in as {name}" before accepting', async () => {
    api.acceptInvite.mockResolvedValue({ ok: true });
    const container = await show("tok-abcdefghijklmnop", "carol");
    expect(text(container)).toContain("Signed in as carol. Accepting signs carol out.");
    expect(container.querySelector("form")).toBeNull();
    await click(button(container, "Continue"));
    expect(container.querySelector("form")).not.toBeNull();
    expect(hasButton(container, "Create my account")).toBe(true);
  });

  it("going back leaves the invitation address without accepting", async () => {
    window.history.replaceState(null, "", "/invite");
    const container = await show("tok-abcdefghijklmnop", "carol");
    await click(button(container, "Go back"));
    expect(onDone).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe("/");
    expect(api.acceptInvite).not.toHaveBeenCalled();
  });

  it("a throttled or unreachable check offers Retry with the held token; a 404 is final", async () => {
    vi.useFakeTimers();
    const tick = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    api.inviteInfo
      .mockResolvedValueOnce({ ok: false, code: "rate_limited", retryAfterSeconds: 3 })
      .mockResolvedValueOnce({ ok: false, code: "offline", retryAfterSeconds: null })
      .mockResolvedValueOnce({ ok: true, inviter: "ana", expiresAt: 1 });
    page = await mount(<InviteScreen token="tok-abcdefghijklmnop" signedInAs={null} onDone={onDone} />);
    await tick();
    const container = page.container;
    expect(alerts(container)).toEqual(["Too many attempts. Wait 3 s."]);
    expect(container.querySelector("form")).toBeNull();
    expect(button(container, "Retry").disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(button(container, "Retry").disabled).toBe(false);
    await click(button(container, "Retry"));
    await tick();
    expect(alerts(container)).toEqual([
      "pap is unreachable: this page cannot reach the daemon. Your drafts stay on this device. Check that pap is running, then retry.",
    ]);
    await click(button(container, "Retry"));
    await tick();
    expect(text(container)).toContain("ana invites you.");
    expect(api.inviteInfo.mock.calls.map((call) => call[0])).toEqual([
      "tok-abcdefghijklmnop",
      "tok-abcdefghijklmnop",
      "tok-abcdefghijklmnop",
    ]);
  });

  it("a 404 is final: no Retry", async () => {
    api.inviteInfo.mockResolvedValue(failed("invite_invalid"));
    const container = await show();
    expect(hasButton(container, "Retry")).toBe(false);
  });

  it("forgets the password once the passkey step is shown", async () => {
    api.acceptInvite.mockResolvedValue({ ok: true });
    const container = await show();
    await fill(container);
    await click(button(container, "Create my account"));
    await settle();
    expect(text(container)).toContain("Add a passkey");
    const values = [...container.querySelectorAll("input")].map((input) => input.value);
    expect(values).not.toContain("a long enough password");
    expect(container.innerHTML).not.toContain("a long enough password");
  });

  it("account_disabled shows on the sign-in screen", async () => {
    api.login.mockResolvedValue(failed("account_disabled"));
    page = await mount(<LoginScreen passkeysAvailable={false} onDone={onDone} />);
    await typeInto(field(page.container, "Username"), "bob");
    await typeInto(field(page.container, "Password"), "a long enough password");
    await click(button(page.container, "Sign in"));
    await settle();
    expect(alerts(page.container)).toEqual(["This account is disabled. Ask the owner of this pap."]);
  });
});

describe("the token of the address", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("is read from the hash, the hash is cleared with history.replaceState, and the token is never sent in a URL", async () => {
    vi.resetModules();
    window.history.replaceState(null, "", "/invite#token=secret-token-0123456789");
    const replace = vi.spyOn(window.history, "replaceState");
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body) });
        return Promise.resolve(
          new Response(JSON.stringify({ inviter: "ana", expiresAt: 1 }), { status: 200 }),
        );
      }),
    );
    const real = await vi.importActual<typeof import("./auth-api.ts")>("./auth-api.ts");
    const { useAuthGate } = await import("./use-auth-gate.ts");
    api.fetchAuthStatus.mockResolvedValue({
      setupRequired: false,
      authenticated: false,
      username: null,
      role: null,
      passkeysAvailable: false,
    });
    const seen: unknown[] = [];
    function Probe() {
      const { state } = useAuthGate();
      useEffect(() => {
        seen.push(state);
      }, [state]);
      return null;
    }
    page = await mount(<Probe />);
    await settle();
    expect(replace).toHaveBeenCalledWith(null, "", "/invite");
    expect(window.location.hash).toBe("");
    expect(seen.at(-1)).toEqual({ phase: "invite", token: "secret-token-0123456789", signedInAs: null });
    await real.inviteInfo("secret-token-0123456789");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/auth/invite/info");
    expect(calls[0]?.body).toContain("secret-token-0123456789");
  });
});

describe("the held token", () => {
  afterEach(() => vi.resetModules());

  async function host(url: string, username: string | null = null) {
    vi.resetModules();
    window.history.replaceState(null, "", url);
    api.fetchAuthStatus.mockResolvedValue({
      setupRequired: false,
      authenticated: username !== null,
      username,
      role: username === null ? null : "owner",
      passkeysAvailable: false,
    });
    const gate = await import("./use-auth-gate.ts");
    const screen = await import("./InviteScreen.tsx");
    const seen: unknown[] = [];
    let refresh = () => {};
    function Host() {
      const { state, refresh: again } = gate.useAuthGate();
      refresh = again;
      useEffect(() => {
        seen.push(state);
      }, [state]);
      return state.phase === "invite" ? (
        <screen.InviteScreen token={state.token} signedInAs={state.signedInAs} onDone={again} />
      ) : null;
    }
    page = await mount(<Host />);
    await settle();
    return { seen, refresh: () => refresh(), container: (page as Mounted).container };
  }
  const token = "first-token-0123456789";

  it("is forgotten after a successful accept, so a later read finds none", async () => {
    api.acceptInvite.mockResolvedValue({ ok: true });
    const { container, refresh, seen } = await host(`/invite#token=${token}`);
    await fill(container);
    await click(button(container, "Create my account"));
    await settle();
    refresh();
    await settle();
    expect(seen.at(-1)).toEqual({ phase: "invite", token: null, signedInAs: null });
  });

  it("is forgotten after a final invite_invalid and when the person goes back", async () => {
    api.inviteInfo.mockResolvedValue(failed("invite_invalid"));
    const refused = await host(`/invite#token=${token}`);
    refused.refresh();
    await settle();
    expect(refused.seen.at(-1)).toMatchObject({ token: null });
    await page?.unmount();

    api.inviteInfo.mockResolvedValue({ ok: true, inviter: "ana", expiresAt: 1 });
    const back = await host(`/invite#token=${token}`, "carol");
    await click(button(back.container, "Go back"));
    await settle();
    window.history.replaceState(null, "", "/invite");
    back.refresh();
    await settle();
    expect(back.seen.at(-1)).toMatchObject({ token: null });
  });

  it("is forgotten when the person navigates away", async () => {
    const { seen, refresh } = await host(`/invite#token=${token}`);
    window.history.replaceState(null, "", "/elsewhere");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.history.replaceState(null, "", "/invite");
    refresh();
    await settle();
    expect(seen.at(-1)).toMatchObject({ token: null });
  });

  it("reads a second invitation link opened in the same tab", async () => {
    const { seen } = await host(`/invite#token=${token}`);
    window.history.replaceState(null, "", "/invite#token=second-token-0123456789");
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle();
    expect(seen.at(-1)).toMatchObject({ token: "second-token-0123456789" });
    expect(window.location.hash).toBe("");
  });
});
