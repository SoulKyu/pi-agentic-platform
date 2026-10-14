// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { button, click, settle, text } from "../../testing/dom.ts";
import { current, newBed, show } from "./models-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const STORE = "pap.models.login";
let seq = 100;

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

/** A page opened after a reload: the flow id is in the session store and nothing is selected. */
async function restored() {
  sessionStorage.setItem(STORE, JSON.stringify({ provider: "anthropic", flowId: "flow-1" }));
  const bed = newBed();
  bed.handlers["subscribe.login"] = () => ({ sub: "L1" });
  const page = await show();
  await settle();
  const emit = (event: unknown) => bed.fake.deliver({ sub: "L1", epoch: "e1", seq: seq++, event });
  return { page, emit };
}

describe("a sign-in restored after a reload", () => {
  it("selects the provider the flow belongs to, so the flow is on screen", async () => {
    const { page } = await restored();
    expect(page.container.querySelector('[data-provider-detail="anthropic"]')).not.toBeNull();
    expect(page.container.querySelector("[data-sign-in-flow]")).not.toBeNull();
  });

  it("does not take the choice back when the owner picks another provider", async () => {
    const { page } = await restored();
    (page.container.querySelector('[data-provider="openai"]') as HTMLButtonElement).click();
    await settle();
    expect(page.container.querySelector('[data-provider-detail="openai"]')).not.toBeNull();
    expect(page.container.querySelector('[data-provider-detail="anthropic"]')).toBeNull();
  });

  it("keeps the provider selected after the restored flow is closed", async () => {
    const { page, emit } = await restored();
    await act(async () => emit({ kind: "snapshot", events: [] }));
    await act(async () => emit({ kind: "done", ok: true }));
    await settle();
    await click(button(page.container, "Close"));
    expect(page.container.querySelector("[data-sign-in-flow]")).toBeNull();
    expect(page.container.querySelector('[data-provider-detail="anthropic"]')).not.toBeNull();
  });

  it("keys the links by position, so two equal addresses make no duplicate key", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { page, emit } = await restored();
    await act(async () => emit({ kind: "snapshot", events: [] }));
    await act(async () =>
      emit({
        kind: "info",
        message: "Help",
        links: [
          { url: "https://example.com/help", label: "First" },
          { url: "https://example.com/help", label: "Second" },
        ],
      }),
    );
    expect(text(page.container)).toContain("First");
    expect(text(page.container)).toContain("Second");
    expect(error).not.toHaveBeenCalled();
  });

  it("says how it ended in the language in use now, and drops the link and the code once it is over", async () => {
    const { page, emit } = await restored();
    await act(async () => emit({ kind: "snapshot", events: [] }));
    await act(async () => emit({ kind: "auth_url", url: "https://example.com/authorize" }));
    await act(async () =>
      emit({
        kind: "device_code",
        userCode: "AB-12",
        verificationUri: "https://example.com/device",
        expiresInSeconds: 600,
      }),
    );
    expect(text(page.container)).toContain("AB-12");
    await act(async () => emit({ kind: "done", ok: true }));
    await settle();
    expect(text(page.container)).toContain("Signed in.");
    expect(page.container.querySelector('a[href="https://example.com/authorize"]')).toBeNull();
    expect(page.container.querySelector("[data-device-code]")).toBeNull();
    expect(text(page.container)).not.toContain("AB-12");
    await act(async () => setLocale("fr"));
    expect(text(page.container)).toContain("Connecté.");
    expect(text(page.container)).not.toContain("Signed in.");
  });
});
