// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { alerts, button, click, field, hasButton, settle, text, typeInto } from "../../testing/dom.ts";
import { current, newBed, prompt, providerButton, show } from "./models-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const STORE = "pap.models.login";
beforeEach(() => {
  sessionStorage.clear();
  prompt.answer = true;
  prompt.asked = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

let seq = 0;
function loginStream(bed: ReturnType<typeof newBed>) {
  bed.handlers["subscribe.login"] = () => ({ sub: "L1" });
  return (event: unknown) => bed.fake.deliver({ sub: "L1", epoch: "e1", seq: seq++, event });
}

async function startOAuth() {
  const bed = newBed();
  const emit = loginStream(bed);
  let attempts = 0;
  bed.handlers["models.login"] = () => {
    attempts += 1;
    if (attempts === 1) throw new RpcError("step_up_required");
    return { flowId: "flow-1" };
  };
  const page = await show();
  await settle();
  await click(providerButton(page.container, "anthropic"));
  await click(button(page.container, "Sign in with Anthropic (Claude Pro/Max)"));
  await settle();
  return { bed, page, emit };
}

describe("OAuth sign-in", () => {
  it("retries after the password step-up, and follows the flow", async () => {
    const { bed, page, emit } = await startOAuth();
    const [first, second] = bed.called("models.login");
    expect(first?.params).toEqual({ provider: "anthropic", method: "oauth" });
    expect(first?.options?.commandId).toBe("stub-command");
    expect(second?.options?.commandId).toBe("stub-command");
    expect(bed.called("subscribe.login").map((call) => call.params)).toEqual([{ flowId: "flow-1" }]);
    expect(JSON.parse(sessionStorage.getItem(STORE) ?? "null")).toEqual({
      provider: "anthropic",
      flowId: "flow-1",
    });
    await act(async () => emit({ kind: "snapshot", events: [] }));
    await act(async () =>
      emit({ kind: "auth_url", url: "https://example.com/authorize", instructions: "Sign in there." }),
    );
    const link = page.container.querySelector('a[href="https://example.com/authorize"]');
    expect(link?.textContent).toBe("Open the sign-in page");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(text(page.container)).toContain("Sign in there.");
  });

  it("sends the pasted code with models.loginAnswer and clears the field", async () => {
    const { bed, page, emit } = await startOAuth();
    await act(async () =>
      emit({
        kind: "prompt",
        promptId: "pr1",
        prompt: { type: "manual_code", message: "from the provider" },
      }),
    );
    const input = field(page.container, "Paste the code or the address your browser ended on");
    await typeInto(input, "http://localhost:1455/cb?code=abc");
    await click(button(page.container, "Continue"));
    await settle();
    expect(bed.called("models.loginAnswer").map((call) => call.params)).toEqual([
      { flowId: "flow-1", promptId: "pr1", value: "http://localhost:1455/cb?code=abc" },
    ]);
    expect(page.container.querySelector<HTMLInputElement>("[data-sign-in-flow] input")?.value ?? "").toBe("");
  });

  it("shows a secret prompt as a password field", async () => {
    const { page, emit } = await startOAuth();
    await act(async () =>
      emit({ kind: "prompt", promptId: "pr2", prompt: { type: "secret", message: "Token" } }),
    );
    expect(field(page.container, "Token").type).toBe("password");
  });

  it("shows the device code with a copy button", async () => {
    const { page, emit } = await startOAuth();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await act(async () =>
      emit({
        kind: "device_code",
        userCode: "AB-12",
        verificationUri: "https://example.com/device",
        expiresInSeconds: 600,
      }),
    );
    expect(text(page.container)).toContain("AB-12");
    expect(text(page.container)).toContain("The code expires in 10 min.");
    await click(button(page.container, "Copy code"));
    expect(writeText).toHaveBeenCalledWith("AB-12");
    expect(text(page.container)).toContain("Copied.");
  });

  it("shows the fixed text for a timeout, forgets the flow and reads the providers again", async () => {
    const { bed, page, emit } = await startOAuth();
    const before = bed.called("models.overview").length;
    await act(async () => emit({ kind: "done", ok: false, code: "timeout" }));
    await settle();
    expect(text(page.container)).toContain("Sign-in took too long and was stopped.");
    expect(sessionStorage.getItem(STORE)).toBeNull();
    expect(bed.called("models.overview").length).toBe(before + 1);
  });

  it("cancels with models.loginCancel, with a button that is not the danger one", async () => {
    const { bed, page } = await startOAuth();
    const cancel = button(page.container, "Cancel sign-in");
    expect(cancel.getAttribute("data-variant")).not.toBe("danger");
    await click(cancel);
    await settle();
    expect(bed.called("models.loginCancel").map((call) => call.params)).toEqual([{ flowId: "flow-1" }]);
    expect(sessionStorage.getItem(STORE)).toBeNull();
    expect(hasButton(page.container, "Cancel sign-in")).toBe(false);
  });

  it("leaves everything alone when the password prompt is cancelled", async () => {
    prompt.answer = false;
    const bed = newBed();
    bed.handlers["models.login"] = () => {
      throw new RpcError("step_up_required");
    };
    const page = await show();
    await settle();
    await click(providerButton(page.container, "anthropic"));
    await click(button(page.container, "Sign in with Anthropic (Claude Pro/Max)"));
    await settle();
    expect(prompt.asked).toBe(1);
    expect(bed.called("models.login")).toHaveLength(1);
    expect(sessionStorage.getItem(STORE)).toBeNull();
    expect(alerts(page.container)).toEqual([]);
  });
});

describe("a reload during a sign-in (MC31)", () => {
  it("subscribes again to the flow whose id is in sessionStorage and shows its snapshot", async () => {
    sessionStorage.setItem(STORE, JSON.stringify({ provider: "anthropic", flowId: "flow-9" }));
    const bed = newBed();
    const emit = loginStream(bed);
    const page = await show();
    await settle();
    expect(bed.called("subscribe.login").map((call) => call.params)).toEqual([{ flowId: "flow-9" }]);
    await act(async () =>
      emit({ kind: "snapshot", events: [{ kind: "auth_url", url: "https://example.com/again" }] }),
    );
    await click(providerButton(page.container, "anthropic"));
    expect(page.container.querySelector('a[href="https://example.com/again"]')).not.toBeNull();
  });

  it("forgets a flow the server no longer knows and reads the providers again", async () => {
    sessionStorage.setItem(STORE, JSON.stringify({ provider: "anthropic", flowId: "flow-9" }));
    const bed = newBed();
    bed.handlers["subscribe.login"] = () => {
      throw new RpcError("not_found");
    };
    const page = await show();
    await settle();
    expect(sessionStorage.getItem(STORE)).toBeNull();
    expect(text(page.container)).toContain("That sign-in is over, or it was not started from this account.");
  });

  it("ignores a record that is not a provider and a flow id", async () => {
    sessionStorage.setItem(STORE, JSON.stringify({ provider: 3, flowId: "x".repeat(65) }));
    const bed = newBed();
    await show();
    await settle();
    expect(bed.called("subscribe.login")).toEqual([]);
  });

  it("offers to cancel by provider when the server says a flow is already running and the id is lost", async () => {
    const bed = newBed();
    bed.handlers["models.login"] = () => {
      throw new RpcError("conflict");
    };
    const page = await show();
    await settle();
    await click(providerButton(page.container, "anthropic"));
    await click(button(page.container, "Sign in with Anthropic (Claude Pro/Max)"));
    await settle();
    expect(text(page.container)).toContain("A sign-in for this provider is already running");
    await click(button(page.container, "Cancel that sign-in"));
    await settle();
    expect(bed.called("models.cancelLogin").map((call) => call.params)).toEqual([{ provider: "anthropic" }]);
    expect(bed.called("models.loginCancel")).toEqual([]);
    expect(hasButton(page.container, "Cancel that sign-in")).toBe(false);
  });
});

describe("API key", () => {
  async function openKey() {
    const bed = newBed();
    const page = await show();
    await settle();
    await click(providerButton(page.container, "anthropic"));
    await click(button(page.container, "Paste a key"));
    return { bed, page };
  }

  it("sends the key behind the password step-up and empties the field once the call returns", async () => {
    const { bed, page } = await openKey();
    let attempts = 0;
    bed.handlers["models.setApiKey"] = () => {
      attempts += 1;
      if (attempts === 1) throw new RpcError("step_up_required");
      return { ok: true };
    };
    await typeInto(field(page.container, "API key"), "sk-secret-123");
    await click(button(page.container, "Save key"));
    await settle();
    expect(bed.called("models.setApiKey").map((call) => call.params)).toEqual([
      { provider: "anthropic", key: "sk-secret-123" },
      { provider: "anthropic", key: "sk-secret-123" },
    ]);
    expect(document.body.innerHTML).not.toContain("sk-secret-123");
    expect(text(page.container)).toContain("Key saved.");
    expect(bed.called("models.overview")).toHaveLength(2);
  });

  it("empties the field when the call fails too, and says why", async () => {
    const { bed, page } = await openKey();
    bed.handlers["models.setApiKey"] = () => {
      throw new RpcError("config_path_refused");
    };
    await typeInto(field(page.container, "API key"), "sk-secret-456");
    await click(button(page.container, "Save key"));
    await settle();
    expect(field(page.container, "API key").value).toBe("");
    expect(document.body.innerHTML).not.toContain("sk-secret-456");
    expect(alerts(page.container)).toHaveLength(1);
  });

  it("refuses a key that starts with ! without sending it", async () => {
    const { bed, page } = await openKey();
    await typeInto(field(page.container, "API key"), "!echo hi");
    await click(button(page.container, "Save key"));
    await settle();
    expect(bed.called("models.setApiKey")).toEqual([]);
    expect(text(page.container)).toContain("A key cannot start with !");
  });

  it("is a password field", async () => {
    const { page } = await openKey();
    expect(field(page.container, "API key").type).toBe("password");
  });
});

describe("sign out", () => {
  it("asks first, then removes the stored sign-in without a password", async () => {
    const bed = newBed();
    const page = await show();
    await settle();
    await click(providerButton(page.container, "openai"));
    await click(button(page.container, "Sign out"));
    expect(bed.called("models.logout")).toEqual([]);
    await click(button(page.container, "Remove"));
    await settle();
    expect(bed.called("models.logout").map((call) => call.params)).toEqual([{ provider: "openai" }]);
    expect(prompt.asked).toBe(0);
  });
});
