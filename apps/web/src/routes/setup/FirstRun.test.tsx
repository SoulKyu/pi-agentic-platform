// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { current, newBed, overviewOf, PROVIDERS } from "../../features/models/models-bed.tsx";
import {
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
import { FirstRun } from "./FirstRun.tsx";

const api = vi.hoisted(() => ({
  setupOwner: vi.fn(),
  fetchAuthStatus: vi.fn(),
  registerPasskey: vi.fn(),
  confirmPassword: vi.fn(),
}));
vi.mock("../../features/auth/auth-api.ts", () => api);
vi.mock("../../features/auth/passkey-support.ts", () => ({ passkeysUsable: () => true }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let page: Mounted | null = null;
const onDone = vi.fn();

async function toPiStep(overview = overviewOf()) {
  newBed(overview);
  window.history.replaceState(null, "", "/setup#token=tok");
  page = await mount(<FirstRun onDone={onDone} onAccountCreated={vi.fn()} />);
  await typeInto(field(page.container, "Username"), "ana");
  await typeInto(field(page.container, "Password"), "a long enough password");
  await click(button(page.container, "Create account"));
  await settle();
  await click(button(page.container, "Skip"));
  await settle();
  await settle();
  return page.container;
}

beforeEach(() => {
  api.setupOwner.mockReset().mockResolvedValue({ ok: true });
  api.fetchAuthStatus.mockReset().mockResolvedValue({
    setupRequired: false,
    authenticated: true,
    username: "ana",
    passkeysAvailable: true,
  });
  onDone.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("FirstRun", () => {
  it("loads the provider list of Settings in the Pi step when nothing is configured", async () => {
    const none = PROVIDERS.map((provider) => ({
      ...provider,
      auth: { ...provider.auth, configured: false, env: [] },
    }));
    const container = await toPiStep(
      overviewOf({ providers: none, defaults: { provider: null, model: null, thinkingLevel: null } }),
    );
    expect(container.querySelector('[aria-label="Providers"]')).not.toBeNull();
    expect(text(container)).not.toContain("Ready");
  });

  it("says Ready with the default model when a provider is signed in, and finishes", async () => {
    const container = await toPiStep();
    expect(text(container)).toContain("Ready");
    expect(text(container)).toContain("gpt-a from openai");
    expect(hasButton(container, "Change")).toBe(true);
    await click(button(container, "Finish"));
    expect(onDone).toHaveBeenCalledOnce();
  });
});
