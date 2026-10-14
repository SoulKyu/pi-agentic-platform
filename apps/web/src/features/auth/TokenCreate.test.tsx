// @vitest-environment happy-dom
import { act } from "react";
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
  settle,
  text,
  typeInto,
  type Mounted,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { TokenCreate } from "./TokenCreate.tsx";

registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });

const api = vi.hoisted(() => ({ confirmPassword: vi.fn() }));
vi.mock("./auth-api.ts", () => api);
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const VALUE = `pap_${"Zq7".repeat(14).slice(0, 43)}`;
const TOKEN_VIEW = {
  id: "t1",
  name: "ci",
  hint: "Zq7Z",
  permissions: ["sessions:read"],
  createdAt: 1,
  expiresAt: 2,
  lastUsedAt: null,
};

let bed = fakeRuntime();
let page: Mounted | null = null;
const onCreated = vi.fn();
const onSignedOut = vi.fn();
const writeText = vi.fn();
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  api.confirmPassword.mockReset();
  onCreated.mockReset();
  onSignedOut.mockReset();
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.restoreAllMocks();
});

const dialog = () => document.querySelector('[data-slot="dialog"]') as HTMLElement;
const cell = (permission: string) =>
  document.querySelector(`[data-permission="${permission}"] [role="checkbox"]`) as HTMLElement;
const checked = (permission: string) => cell(permission).getAttribute("aria-checked") === "true";

async function show() {
  page = await mount(<TokenCreate onCreated={onCreated} onSignedOut={onSignedOut} />);
  return page.container;
}
async function fill(container: HTMLElement, permission = "sessions:read") {
  await typeInto(field(container, "Name"), "ci");
  await click(cell(permission));
}
async function submit(container: HTMLElement) {
  await click(button(container, "Create token"));
  await settle();
}
async function confirmPrompt() {
  await typeInto(field(dialog(), "Password"), "correct horse battery staple");
  await click(button(dialog(), "Confirm"));
  await settle();
}
const valueField = (container: HTMLElement) => field(container, "Token value");

describe("create form", () => {
  it("creates through the step-up, shows the value once, and forgets it on Done", async () => {
    const consoleCalls = ["log", "warn", "error", "info", "debug"].map((name) =>
      vi.spyOn(console, name as "log").mockImplementation(() => {}),
    );
    const container = await show();
    let calls = 0;
    bed.handlers["auth.tokens.create"] = () => {
      calls += 1;
      if (calls === 1) throw new RpcError("step_up_required");
      return { token: TOKEN_VIEW, value: VALUE };
    };
    api.confirmPassword.mockResolvedValue({ ok: true });
    await fill(container);
    await submit(container);
    await confirmPrompt();
    expect(valueField(container).value).toBe(VALUE);
    expect(valueField(container).readOnly).toBe(true);
    const [first, second] = bed.called("auth.tokens.create");
    expect(first?.params).toEqual({ name: "ci", permissions: ["sessions:read"], expiresInDays: 90 });
    expect(first?.options?.commandId).toBe("bed-cmd-00000001");
    expect(second?.options?.commandId).toBe("bed-cmd-00000001");
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onCreated.mock.calls)).not.toContain(VALUE);
    await click(button(container, "Done"));
    expect(document.body.innerHTML).not.toContain(VALUE);
    expect(hasButton(container, "Create token")).toBe(true);
    expect(document.activeElement).toBe(field(container, "Name"));
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(VALUE);
    expect(location.href).not.toContain(VALUE);
    expect(JSON.stringify(consoleCalls.map((spy) => spy.mock.calls))).not.toContain(VALUE);
  });

  it("drops the value when the screen goes away", async () => {
    const container = await show();
    bed.handlers["auth.tokens.create"] = () => ({ token: TOKEN_VIEW, value: VALUE });
    await fill(container);
    await submit(container);
    expect(document.body.innerHTML).toContain(VALUE);
    await page?.unmount();
    page = null;
    expect(document.body.innerHTML).not.toContain(VALUE);
  });

  it("sends the chosen lifetime and every ticked permission in the catalogue's order", async () => {
    const container = await show();
    bed.handlers["auth.tokens.create"] = () => ({ token: TOKEN_VIEW, value: VALUE });
    await typeInto(field(container, "Name"), "  ci  ");
    await click(cell("sessions:operate"));
    await click(cell("audit:read"));
    await click(cell("sessions:read"));
    await click(cell("audit:read"));
    await click(button(container, "30 days"));
    await submit(container);
    expect(bed.called("auth.tokens.create").map((call) => call.params)).toEqual([
      { name: "ci", permissions: ["sessions:read", "sessions:operate"], expiresInDays: 30 },
    ]);
  });

  it("offers 7, 30, 90 and 365 days with 90 selected", async () => {
    const container = await show();
    const items = [...container.querySelectorAll('[data-slot="segmented"] button')];
    expect(items.map((item) => item.textContent)).toEqual(["7 days", "30 days", "90 days", "365 days"]);
    expect(items.map((item) => item.getAttribute("aria-checked") ?? item.getAttribute("data-state"))).toEqual(
      items.map((_, index) =>
        index === 2 ? expect.stringMatching(/true|on/) : expect.stringMatching(/false|off/),
      ),
    );
  });

  it("never offers auth or policy:admin, and offers policy read and operate", async () => {
    const container = await show();
    expect(container.querySelector('[data-permission^="auth:"]')).toBeNull();
    expect(container.querySelector('[data-permission="policy:admin"]')).toBeNull();
    expect(container.querySelector('[data-permission="policy:operate"]')).not.toBeNull();
    expect(container.querySelector('[data-permission="policy:read"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-permission]")).toHaveLength(20);
    expect(text(container)).toContain("Changing approval modes and rules needs your browser session.");
  });

  it("warns for sessions:operate only, and the warning goes when it is unticked", async () => {
    const container = await show();
    const warning = "This token can send prompts and answer approval cards in your name.";
    await click(cell("sessions:read"));
    expect(text(container)).not.toContain(warning);
    await click(cell("sessions:operate"));
    expect(text(container)).toContain(warning);
    await click(cell("sessions:operate"));
    expect(text(container)).not.toContain(warning);
  });

  it("needs a name and one permission before Create is possible", async () => {
    const container = await show();
    expect(button(container, "Create token").disabled).toBe(true);
    await typeInto(field(container, "Name"), "ci");
    expect(button(container, "Create token").disabled).toBe(true);
    await click(cell("sessions:read"));
    expect(checked("sessions:read")).toBe(true);
    expect(button(container, "Create token").disabled).toBe(false);
    await typeInto(field(container, "Name"), "   ");
    expect(button(container, "Create token").disabled).toBe(true);
    await typeInto(field(container, "Name"), "x".repeat(65));
    expect(button(container, "Create token").disabled).toBe(true);
    expect(bed.called("auth.tokens.create")).toEqual([]);
  });

  it("explains a lost value when the create answers conflict, without showing a value", async () => {
    const container = await show();
    bed.handlers["auth.tokens.create"] = () => {
      throw new RpcError("conflict");
    };
    await fill(container);
    await submit(container);
    expect(text(container)).toContain(
      "The token was created, but its value did not reach this page. Revoke it and create another.",
    );
    expect(container.querySelector("input[readonly]")).toBeNull();
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "connection_lost"] as const)(
    "says the token may exist after %s, and does not retry",
    async (code) => {
      const container = await show();
      bed.handlers["auth.tokens.create"] = () => {
        throw new RpcError(code);
      };
      await fill(container);
      await submit(container);
      expect(alerts(container)).toEqual([
        "It may have been created. If it appears in the list, revoke it and create a new one.",
      ]);
      expect(bed.called("auth.tokens.create")).toHaveLength(1);
      expect(onCreated).toHaveBeenCalledTimes(1);
    },
  );

  it("sends exactly one create when Enter submits the password prompt", async () => {
    const container = await show();
    let calls = 0;
    bed.handlers["auth.tokens.create"] = () => {
      calls += 1;
      if (calls === 1) throw new RpcError("step_up_required");
      return { token: TOKEN_VIEW, value: VALUE };
    };
    api.confirmPassword.mockResolvedValue({ ok: true });
    await fill(container);
    await submit(container);
    expect(dialog().closest("form")).toBeNull();
    await typeInto(field(dialog(), "Password"), "correct horse battery staple");
    await act(async () => {
      dialog().querySelector("form")?.requestSubmit();
    });
    await settle();
    expect(bed.called("auth.tokens.create")).toHaveLength(2);
    expect(valueField(container).value).toBe(VALUE);
  });

  it("leaves nothing pending and no error when the password prompt is cancelled", async () => {
    const container = await show();
    bed.handlers["auth.tokens.create"] = () => {
      throw new RpcError("step_up_required");
    };
    await fill(container);
    await submit(container);
    await click(button(dialog(), "Cancel"));
    await settle();
    expect(dialog()).toBeNull();
    expect(alerts(container)).toEqual([]);
    expect(bed.called("auth.tokens.create")).toHaveLength(1);
    expect(container.querySelector("input[readonly]")).toBeNull();
    expect(button(container, "Create token").disabled).toBe(false);
  });

  it("shows a refusal and keeps the form", async () => {
    const container = await show();
    bed.handlers["auth.tokens.create"] = () => {
      throw new RpcError("limit_reached");
    };
    await fill(container);
    await submit(container);
    expect(alerts(container)).toEqual(["This list is full. Remove an entry first."]);
    expect(field(container, "Name").value).toBe("ci");
  });

  it("sends one create at a time", async () => {
    const container = await show();
    bed.handlers["auth.tokens.create"] = () => new Promise(() => {});
    await fill(container);
    await click(button(container, "Create token"));
    expect(button(container, "Create token").disabled).toBe(true);
    await click(button(container, "Create token"));
    expect(bed.called("auth.tokens.create")).toHaveLength(1);
  });
});

describe("value", () => {
  async function created() {
    const container = await show();
    bed.handlers["auth.tokens.create"] = () => ({ token: TOKEN_VIEW, value: VALUE });
    await fill(container);
    await submit(container);
    return container;
  }

  it("copies with the clipboard", async () => {
    const container = await created();
    writeText.mockResolvedValue(undefined);
    await click(button(container, "Copy"));
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(VALUE);
    expect(text(container)).toContain("Copied");
    expect(text(container)).not.toContain("Select the text and copy it");
  });

  it("says to select the text when the clipboard refuses", async () => {
    const container = await created();
    writeText.mockRejectedValue(new Error("denied"));
    await click(button(container, "Copy"));
    await settle();
    expect(text(container)).toContain("Select the text and copy it");
    expect(valueField(container).value).toBe(VALUE);
  });

  it("says to select the text when there is no clipboard at all", async () => {
    const container = await created();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await click(button(container, "Copy"));
    await settle();
    expect(text(container)).toContain("Select the text and copy it");
  });
});
