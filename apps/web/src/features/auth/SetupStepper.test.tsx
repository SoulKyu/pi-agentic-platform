// @vitest-environment happy-dom
import type { ModelsOverview } from "@pap/contracts";
import { useEffect, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import {
  alerts,
  button,
  click,
  field,
  hasButton,
  mount,
  settle,
  typeInto,
  text,
  type Mounted,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SetupStepper } from "./SetupStepper.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const api = vi.hoisted(() => ({
  setupOwner: vi.fn(),
  fetchAuthStatus: vi.fn(),
  registerPasskey: vi.fn(),
  confirmPassword: vi.fn(),
}));
const browser = vi.hoisted(() => ({ webauthn: true }));
vi.mock("./auth-api.ts", () => api);
vi.mock("./passkey-support.ts", () => ({
  passkeysUsable: (serverAllows: boolean) => serverAllows && browser.webauthn,
}));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

type Models = ComponentType<{ stepUp: <T>(run: (id: string) => Promise<T>) => Promise<T | null> }>;
const asked: string[] = [];
const Models: Models = ({ stepUp }) => {
  useEffect(() => {
    void stepUp(async (id) => id).then((id) => asked.push(String(id)));
  }, [stepUp]);
  return <p data-stub="models">provider list</p>;
};

const empty: ModelsOverview = {
  providers: [],
  defaults: { provider: null, model: null, thinkingLevel: null },
  enabled: { patterns: [], scope: "global", settingsPath: "/a", warnings: [] },
  offline: false,
  truncated: false,
};
const ready: ModelsOverview = {
  ...empty,
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      origin: "builtin",
      auth: { oauthLabel: null, apiKey: true, configured: true, stored: "api_key", status: "known", env: [] },
      models: [],
      modelsTruncated: false,
    },
  ],
  defaults: { provider: "openai", model: "gpt-a", thinkingLevel: null },
};

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;
const onDone = vi.fn();
const created = vi.fn();

async function atStep1(overview: ModelsOverview = empty) {
  bed.handlers["models.overview"] = () => overview;
  window.history.replaceState(null, "", "/setup#token=tok");
  page = await mount(<SetupStepper onDone={onDone} onAccountCreated={created} models={Models} />);
  await typeInto(field(page.container, "Username"), "ana");
  await typeInto(field(page.container, "Password"), "a long enough password");
  await click(button(page.container, "Create account"));
  await settle();
  return page.container;
}
const heading = (container: HTMLElement) => container.querySelector("h1")?.textContent;
const current_ = (container: HTMLElement) =>
  container.querySelector('[aria-current="step"]')?.textContent ?? null;

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  api.setupOwner.mockReset().mockResolvedValue({ ok: true });
  api.fetchAuthStatus.mockReset().mockResolvedValue({
    setupRequired: false,
    authenticated: true,
    username: "ana",
    passkeysAvailable: true,
  });
  api.registerPasskey.mockReset();
  browser.webauthn = true;
  onDone.mockReset();
  created.mockReset();
  asked.length = 0;
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("SetupStepper", () => {
  it("starts on the account form, announced as the current step, and does not leave until the account exists", async () => {
    window.history.replaceState(null, "", "/setup#token=tok");
    page = await mount(<SetupStepper onDone={onDone} onAccountCreated={created} models={Models} />);
    expect(heading(page.container)).toBe("Create the owner account");
    expect(current_(page.container)).toContain("Account");
    expect(page.container.querySelectorAll("ol li")).toHaveLength(3);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("tells the host once the account exists, and not before", async () => {
    window.history.replaceState(null, "", "/setup#token=tok");
    page = await mount(<SetupStepper onDone={onDone} onAccountCreated={created} models={Models} />);
    expect(created).not.toHaveBeenCalled();
    await typeInto(field(page.container, "Username"), "ana");
    await typeInto(field(page.container, "Password"), "a long enough password");
    await click(button(page.container, "Create account"));
    await settle();
    expect(created).toHaveBeenCalledOnce();
  });

  it("shows the passkey step after the account, and moves focus to its heading", async () => {
    const container = await atStep1();
    expect(heading(container)).toBe("Add a passkey");
    expect(current_(container)).toContain("Passkey");
    expect(document.activeElement).toBe(container.querySelector("h1"));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("offers Add a passkey, and Skip goes to the Pi step", async () => {
    const container = await atStep1();
    expect(hasButton(container, "Add a passkey")).toBe(true);
    await click(button(container, "Skip"));
    expect(heading(container)).toBe("Connect Pi");
    expect(current_(container)).toContain("Pi");
    expect(document.activeElement).toBe(container.querySelector("h1"));
  });

  it("goes to the Pi step once the passkey is added", async () => {
    api.registerPasskey.mockResolvedValue({ ok: true });
    const container = await atStep1();
    await click(button(container, "Add a passkey"));
    await typeInto(field(container, "Password"), "a long enough password");
    await click(button(container, "Add a passkey"));
    await settle();
    expect(text(container)).toContain("Passkey added.");
    await click(button(container, "Continue"));
    expect(heading(container)).toBe("Connect Pi");
  });

  it("tells that passkeys are unavailable and offers Continue", async () => {
    browser.webauthn = false;
    const container = await atStep1();
    expect(hasButton(container, "Add a passkey")).toBe(false);
    expect(text(container)).toContain("Passkeys are not available");
    await click(button(container, "Continue"));
    expect(heading(container)).toBe("Connect Pi");
  });

  it("leaves for sign-in when the passkey call finds the session gone", async () => {
    api.registerPasskey.mockResolvedValue({ ok: false, code: "unauthenticated", retryAfterSeconds: null });
    const container = await atStep1();
    await click(button(container, "Add a passkey"));
    await typeInto(field(container, "Password"), "a long enough password");
    await click(button(container, "Add a passkey"));
    await settle();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("shows Ready with the default model and a Change link when a provider is signed in", async () => {
    const container = await atStep1(ready);
    await click(button(container, "Skip"));
    await settle();
    expect(text(container)).toContain("Ready");
    expect(text(container)).toContain("gpt-a from openai");
    expect(container.querySelector("[data-stub=models]")).toBeNull();
    await click(button(container, "Change"));
    await settle();
    expect(container.querySelector("[data-stub=models]")).not.toBeNull();
  });

  it("shows the provider panel without a configured provider, handing it the step-up runner", async () => {
    const container = await atStep1(empty);
    await click(button(container, "Skip"));
    await settle();
    expect(container.querySelector("[data-stub=models]")).not.toBeNull();
    expect(text(container)).not.toContain("Ready");
    expect(asked).toHaveLength(1);
  });

  it("says when the providers cannot be read, and tries again", async () => {
    const container = await atStep1(empty);
    bed.handlers["models.overview"] = () => {
      throw new Error("boom");
    };
    await click(button(container, "Skip"));
    await settle();
    expect(alerts(container)).toHaveLength(1);
    bed.handlers["models.overview"] = () => empty;
    await click(button(container, "Try again"));
    await settle();
    expect(container.querySelector("[data-stub=models]")).not.toBeNull();
  });

  it("finishes from the Pi step, whether skipped or ready", async () => {
    const container = await atStep1(empty);
    await click(button(container, "Skip"));
    await settle();
    await click(button(container, "Skip"));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("labels the last button Finish when Pi is ready", async () => {
    const container = await atStep1(ready);
    await click(button(container, "Skip"));
    await settle();
    await click(button(container, "Finish"));
    expect(onDone).toHaveBeenCalledOnce();
  });
});
