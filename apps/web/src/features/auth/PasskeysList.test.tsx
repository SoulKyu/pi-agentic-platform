// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsAccessEn, settingsAccessFr } from "../../i18n/catalog/settings-access.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import {
  alerts,
  button,
  click,
  field,
  hasButton,
  mount,
  press,
  settle,
  text,
  typeInto,
  type Mounted,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { PasskeysList } from "./PasskeysList.tsx";

registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });

const api = vi.hoisted(() => ({ confirmPassword: vi.fn(), registerPasskey: vi.fn() }));
vi.mock("./auth-api.ts", () => api);
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed = fakeRuntime();
let page: Mounted | null = null;
const onSignedOut = vi.fn();
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  api.confirmPassword.mockReset();
  api.registerPasskey.mockReset();
  onSignedOut.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const passkey = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: Date.UTC(2026, 9, 5, 8),
  lastUsedAt: null,
  transports: [],
  ...over,
});
const two = [
  passkey("k2", {
    createdAt: Date.UTC(2026, 9, 8, 8),
    lastUsedAt: Date.UTC(2026, 9, 9, 8),
    transports: ["internal", "hybrid"],
  }),
  passkey("k1"),
];
const dialog = () => document.querySelector('[data-slot="dialog"]') as HTMLElement;
const removeLabel = (day: string) => `Remove passkey created ${day}`;
const heading = () => document.querySelector("h3[tabindex]");
const when = (millis: number) => new Date(millis).toLocaleString("en");

async function show(passkeys: unknown[] = two, available = true) {
  bed.handlers["auth.passkeys.list"] = () => ({ passkeys });
  page = await mount(<PasskeysList passkeysAvailable={available} onSignedOut={onSignedOut} />);
  await settle();
  return page.container;
}
/** First call needs a step-up, the second (same commandId) goes through. */
function removeNeedsStepUp(revoked: number) {
  let calls = 0;
  bed.handlers["auth.passkeys.remove"] = () => {
    calls += 1;
    if (calls === 1) throw new RpcError("step_up_required");
    return { revoked };
  };
}
async function startRemoval(container: HTMLElement) {
  await click(button(container, removeLabel(when(Date.UTC(2026, 9, 8, 8)))));
  await click(button(container, "Remove passkey"));
  await settle();
}

describe("passkeys", () => {
  it("lists created, last used and transports in the order the server answered, with Add passkey", async () => {
    const container = await show();
    const rows = [...container.querySelectorAll("[data-passkey]")];
    expect(rows.map((row) => row.getAttribute("data-passkey"))).toEqual(["k2", "k1"]);
    const first = text(rows[0] as Element);
    expect(first).toContain(when(Date.UTC(2026, 9, 8, 8)));
    expect(first).toContain(when(Date.UTC(2026, 9, 9, 8)));
    expect(first).toContain("internal, hybrid");
    expect(text(rows[1] as Element)).toContain("Never used");
    expect(hasButton(container, "Add a passkey")).toBe(true);
  });

  it("hides Add passkey when this browser cannot use one, and says so when there are none", async () => {
    const container = await show([], false);
    expect(hasButton(container, "Add a passkey")).toBe(false);
    expect(text(container)).toContain("No passkeys yet.");
  });

  it("asks inline with the sign-out warning before anything is sent", async () => {
    const container = await show();
    await click(button(container, removeLabel(when(Date.UTC(2026, 9, 8, 8)))));
    expect(text(container)).toContain("Browsers that signed in with this passkey are signed out too.");
    expect(bed.called("auth.passkeys.remove")).toEqual([]);
    await click(button(container, "Cancel"));
    expect(text(container)).not.toContain("signed out too");
  });

  it("goes through the password prompt on step_up_required and sends the same commandId again", async () => {
    const container = await show();
    removeNeedsStepUp(2);
    api.confirmPassword.mockResolvedValue({ ok: true });
    bed.handlers["auth.passkeys.list"] = () => ({ passkeys: [two[1]] });
    await startRemoval(container);
    expect(dialog()).not.toBeNull();
    expect(text(dialog())).toContain("Confirm your password");
    await typeInto(field(dialog(), "Password"), "correct horse battery");
    await click(button(dialog(), "Confirm"));
    await settle();
    expect(api.confirmPassword).toHaveBeenCalledExactlyOnceWith("correct horse battery");
    const calls = bed.called("auth.passkeys.remove");
    expect(calls.map((call) => call.params)).toEqual([{ passkeyId: "k2" }, { passkeyId: "k2" }]);
    expect(calls.map((call) => call.options?.commandId)).toEqual(["bed-cmd-00000001", "bed-cmd-00000001"]);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(heading());
    expect(container.querySelectorAll("[data-passkey]")).toHaveLength(1);
    expect(text(container)).toContain("2 browsers signed out");
  });

  it("says nothing about browsers when none were signed out, and warns about the password after the last one", async () => {
    const container = await show([two[1]]);
    bed.handlers["auth.passkeys.remove"] = () => ({ revoked: 0 });
    bed.handlers["auth.passkeys.list"] = () => ({ passkeys: [] });
    await click(button(container, removeLabel(when(Date.UTC(2026, 9, 5, 8)))));
    await click(button(container, "Remove passkey"));
    await settle();
    expect(text(container)).not.toContain("signed out");
    expect(text(container)).toContain("You will sign in with your password.");
    expect(bed.called("auth.passkeys.remove")).toHaveLength(1);
  });

  it("says one browser in the singular", async () => {
    const container = await show();
    bed.handlers["auth.passkeys.remove"] = () => ({ revoked: 1 });
    await startRemoval(container);
    expect(text(container)).toContain("1 browser signed out");
  });

  it("keeps the prompt open with 'Password incorrect.' after a wrong password, and clears the field", async () => {
    const container = await show();
    removeNeedsStepUp(0);
    api.confirmPassword.mockResolvedValueOnce({ ok: false, code: "password_incorrect" });
    await startRemoval(container);
    await typeInto(field(dialog(), "Password"), "wrong wrong wrong");
    await click(button(dialog(), "Confirm"));
    await settle();
    expect(alerts(dialog())).toEqual(["Password incorrect."]);
    expect(field(dialog(), "Password").value).toBe("");
    expect(bed.called("auth.passkeys.remove")).toHaveLength(1);
    api.confirmPassword.mockResolvedValueOnce({ ok: true });
    await typeInto(field(dialog(), "Password"), "right right right");
    await click(button(dialog(), "Confirm"));
    await settle();
    expect(bed.called("auth.passkeys.remove")).toHaveLength(2);
  });

  it("shows the wait of a throttled confirm", async () => {
    const container = await show();
    removeNeedsStepUp(0);
    api.confirmPassword.mockResolvedValueOnce({ ok: false, code: "rate_limited", retryAfterSeconds: 42 });
    await startRemoval(container);
    await typeInto(field(dialog(), "Password"), "whatever whatever");
    await click(button(dialog(), "Confirm"));
    await settle();
    expect(alerts(dialog())).toEqual(["Too many attempts. Wait 42 s."]);
  });

  it("runs the signed-out flow when the confirm finds no session, and sends nothing more", async () => {
    const container = await show();
    removeNeedsStepUp(0);
    api.confirmPassword.mockResolvedValueOnce({ ok: false, code: "unauthenticated" });
    await startRemoval(container);
    await typeInto(field(dialog(), "Password"), "whatever whatever");
    await click(button(dialog(), "Confirm"));
    await settle();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(bed.called("auth.passkeys.remove")).toHaveLength(1);
  });

  it("leaves nothing pending when the prompt is cancelled, with Escape too", async () => {
    const container = await show();
    removeNeedsStepUp(1);
    await startRemoval(container);
    await click(button(dialog(), "Cancel"));
    await settle();
    expect(dialog()).toBeNull();
    expect(api.confirmPassword).not.toHaveBeenCalled();
    expect(bed.called("auth.passkeys.remove")).toHaveLength(1);
    expect(alerts(container)).toEqual([]);
    expect(document.activeElement).toBe(heading());
    removeNeedsStepUp(1);
    await startRemoval(container);
    expect(bed.called("auth.passkeys.remove")).toHaveLength(2);
    expect(dialog()).not.toBeNull();
    await press(dialog(), { key: "Escape" });
    await settle();
    // Escape closed the dialog and did nothing else: no call but the auth ones (a run is never stopped by it).
    expect(bed.calls.every((call) => call.method.startsWith("auth."))).toBe(true);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(heading());
    expect(api.confirmPassword).not.toHaveBeenCalled();
  });

  it("drops a confirm that answers after the prompt was closed", async () => {
    const container = await show();
    removeNeedsStepUp(1);
    let answer: (value: unknown) => void = () => {};
    api.confirmPassword.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await startRemoval(container);
    await typeInto(field(dialog(), "Password"), "whatever whatever");
    await click(button(dialog(), "Confirm"));
    await press(dialog(), { key: "Escape" });
    await settle();
    expect(dialog()).toBeNull();
    answer({ ok: false, code: "unauthenticated" });
    await settle();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(bed.called("auth.passkeys.remove")).toHaveLength(1);
  });

  it("reloads the list and shows the failure when the removal is refused", async () => {
    const container = await show();
    bed.handlers["auth.passkeys.remove"] = () => {
      throw new RpcError("not_found");
    };
    await startRemoval(container);
    expect(alerts(container)).toEqual(["Not found."]);
    expect(bed.called("auth.passkeys.list")).toHaveLength(2);
  });

  it("reloads the list after Add passkey", async () => {
    const container = await show();
    api.registerPasskey.mockResolvedValue({ ok: true });
    await click(button(container, "Add a passkey"));
    await typeInto(field(container, "Password"), "correct horse battery");
    await click(button(container, "Add a passkey"));
    await settle();
    expect(bed.called("auth.passkeys.list")).toHaveLength(2);
    expect(text(container)).toContain("Passkey added.");
  });
});
