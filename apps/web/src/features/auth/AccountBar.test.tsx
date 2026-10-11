// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { AccountBar } from "./AccountBar.tsx";

const api = vi.hoisted(() => ({ registerPasskey: vi.fn(), logout: vi.fn() }));
vi.mock("./auth-api.ts", () => api);

let page: Mounted | null = null;
const onSignedOut = vi.fn();

beforeEach(() => {
  api.registerPasskey.mockReset();
  api.logout.mockReset();
  onSignedOut.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("AccountBar", () => {
  it("shows who is signed in and signs out through the server, then the gate", async () => {
    api.logout.mockResolvedValue(undefined);
    page = await mount(<AccountBar username="ana" passkeysAvailable={false} onSignedOut={onSignedOut} />);
    expect(text(page.container)).toContain("pap · ana");
    expect(hasButton(page.container, "Add a passkey")).toBe(false);
    await click(button(page.container, "Sign out"));
    await settle();
    expect(api.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it("announces that the passkey was added", async () => {
    api.registerPasskey.mockResolvedValue({ ok: true });
    page = await mount(<AccountBar username="ana" passkeysAvailable onSignedOut={onSignedOut} />);
    await click(button(page.container, "Add a passkey"));
    await typeInto(field(page.container, "Password"), "correct horse battery");
    await click(button(page.container, "Add a passkey"));
    await settle();
    expect(page.container.querySelector('[role="status"]')?.textContent).toBe("Passkey added.");
  });
});
