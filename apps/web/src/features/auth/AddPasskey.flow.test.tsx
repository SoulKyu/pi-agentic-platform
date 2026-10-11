// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alerts, button, click, field, mount, settle, typeInto, type Mounted } from "../../testing/dom.ts";
import { AddPasskey } from "./AddPasskey.tsx";

// Unlike AddPasskey.test.tsx, nothing of the auth module is replaced here: the screen runs on the real
// mapping from what the server answers to what the owner is told (R127.2).
const webauthn = vi.hoisted(() => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => webauthn);

let page: Mounted | null = null;
const props = { onAdded: vi.fn(), onSignedOut: vi.fn() };

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const refusal = (status: number, code: string) => reply(status, { error: { code } });
const status = (authenticated: boolean) =>
  reply(200, { setupRequired: false, authenticated, username: "ana", passkeysAvailable: true });

async function addWith(...answers: Response[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const answer = answers.shift();
      if (!answer) throw new Error("unexpected request");
      return answer;
    }),
  );
  webauthn.startRegistration.mockResolvedValue({ id: "cred" });
  page = await mount(<AddPasskey {...props} />);
  await click(button(page.container, "Add a passkey"));
  await typeInto(field(page.container, "Password"), "correct horse battery");
  await click(button(page.container, "Add a passkey"));
  await settle();
  return page.container;
}

beforeEach(() => {
  webauthn.startRegistration.mockReset();
  props.onAdded.mockReset();
  props.onSignedOut.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.unstubAllGlobals();
});

const options = () => reply(200, { flowId: "f1", options: { challenge: "abc" } });

describe("AddPasskey on the real auth mapping", () => {
  it("shows an error, and stays signed in, when the server refuses the verification with a 401", async () => {
    const container = await addWith(options(), refusal(401, "unauthenticated"), status(true));
    expect(alerts(container)).toEqual(["The passkey could not be used. Try again, or use your password."]);
    expect(props.onSignedOut).not.toHaveBeenCalled();
    expect(props.onAdded).not.toHaveBeenCalled();
    expect(field(container, "Password").value).toBe("correct horse battery");
  });

  it("hands over to sign-in only when /auth/status says the session is gone", async () => {
    await addWith(options(), refusal(401, "unauthenticated"), status(false));
    expect(props.onSignedOut).toHaveBeenCalledOnce();
  });

  it("says the password is incorrect when the options step refuses it", async () => {
    const container = await addWith(refusal(401, "unauthenticated"), status(true));
    expect(alerts(container)).toEqual(["Password incorrect."]);
    expect(props.onSignedOut).not.toHaveBeenCalled();
  });

  it("distinguishes a cancelled prompt from another ceremony error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => options()),
    );
    webauthn.startRegistration.mockRejectedValue(
      Object.assign(new Error("x"), { name: "InvalidStateError" }),
    );
    page = await mount(<AddPasskey {...props} />);
    await click(button(page.container, "Add a passkey"));
    await typeInto(field(page.container, "Password"), "pw");
    await click(button(page.container, "Add a passkey"));
    await settle();
    expect(alerts(page.container)).toEqual([
      "The passkey could not be used. Try again, or use your password.",
    ]);
    webauthn.startRegistration.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    await click(button(page.container, "Add a passkey"));
    await settle();
    expect(alerts(page.container)).toEqual(["The passkey prompt was cancelled."]);
  });
});
