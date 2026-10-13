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
  mount,
  settle,
  text,
  typeInto,
  type Mounted,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { TokensPanel } from "./TokensPanel.tsx";

registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });

vi.mock("./auth-api.ts", () => ({ confirmPassword: vi.fn() }));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed = fakeRuntime();
let page: Mounted | null = null;
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 9, 12, 12));
});
afterEach(async () => {
  vi.useRealTimers();
  await page?.unmount();
  page = null;
});

const when = (millis: number) => new Date(millis).toLocaleString("en");
const token = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `name-${id}`,
  hint: "ab12",
  permissions: ["sessions:read", "audit:read"],
  createdAt: Date.UTC(2026, 9, 1, 8),
  expiresAt: Date.UTC(2026, 11, 1, 8),
  lastUsedAt: null,
  ...over,
});
const live = token("t1", { lastUsedAt: Date.UTC(2026, 9, 10, 8) });
const expired = token("t2", { expiresAt: Date.UTC(2026, 9, 11, 8), permissions: ["system:read"] });

async function show(tokens: unknown[] = [live, expired]) {
  bed.handlers["auth.tokens.list"] = () => ({ tokens });
  page = await mount(<TokensPanel onSignedOut={vi.fn()} />);
  await settle();
  return page.container;
}
const shown = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-token]")].map((el) => el.getAttribute("data-token"));
const row = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-token="${id}"]`) as HTMLElement;

describe("tokens list", () => {
  it("is the section the Devices list links to", async () => {
    const container = await show();
    expect(container.querySelector("section#tokens")).not.toBeNull();
    expect(text(container)).toContain("API tokens");
  });

  it("lists name, hint, count, dates, Expired chip and Never", async () => {
    const container = await show();
    const first = text(row(container, "t1"));
    expect(first).toContain("name-t1");
    expect(first).toContain("…ab12");
    expect(first).toContain("2 permissions");
    expect(first).toContain(`Created ${when(Date.UTC(2026, 9, 1, 8))}`);
    expect(first).toContain(`Expires ${when(Date.UTC(2026, 11, 1, 8))}`);
    expect(first).toContain(`Last used ${when(Date.UTC(2026, 9, 10, 8))}`);
    expect(row(container, "t1").querySelector('[data-slot="chip"]')).toBeNull();
    const second = row(container, "t2");
    expect(text(second)).toContain("1 permission");
    expect(text(second)).toContain("Last used Never");
    expect(second.querySelector('[data-slot="chip"]')?.getAttribute("data-tone")).toBe("err");
    expect(second.querySelector('[data-slot="chip"]')?.textContent).toBe("Expired");
  });

  it("lists the permissions in a disclosure", async () => {
    const container = await show();
    const line = row(container, "t1");
    expect(text(line)).not.toContain("audit:read");
    await click(button(line, "2 permissions"));
    expect(text(line)).toContain("sessions:read");
    expect(text(line)).toContain("audit:read");
  });

  it("says when there is none", async () => {
    const container = await show([]);
    expect(text(container)).toContain("No tokens yet.");
  });

  it("shows a failed load with Try again, which loads again", async () => {
    bed.handlers["auth.tokens.list"] = () => {
      throw new RpcError("internal");
    };
    page = await mount(<TokensPanel onSignedOut={vi.fn()} />);
    await settle();
    expect(alerts(page.container)).toEqual(["Something went wrong."]);
    bed.handlers["auth.tokens.list"] = () => ({ tokens: [live] });
    await click(button(page.container, "Try again"));
    await settle();
    expect(page.container.querySelectorAll("[data-token]")).toHaveLength(1);
  });

  it("drops the answer of a load that a newer load replaced", async () => {
    const answers: Array<(value: unknown) => void> = [];
    bed.handlers["auth.tokens.list"] = () => new Promise((resolve) => answers.push(resolve));
    bed.handlers["auth.tokens.create"] = () => ({ token: live, value: `pap_${"A".repeat(43)}` });
    page = await mount(<TokensPanel onSignedOut={vi.fn()} />);
    await settle();
    // A create finishing while the first load is still out starts a second load.
    await typeInto(field(page.container, "Name"), "ci");
    await click(page.container.querySelector('[data-permission="audit:read"] [role="checkbox"]') as Element);
    await click(button(page.container, "Create token"));
    await settle();
    expect(answers).toHaveLength(2);
    answers[1]?.({ tokens: [expired] });
    await settle();
    answers[0]?.({ tokens: [live] });
    await settle();
    expect(shown(page.container)).toEqual(["t2"]);
  });
});

describe("revoke", () => {
  it("asks inline, sends nothing until confirmed, then reloads", async () => {
    const container = await show();
    bed.handlers["auth.tokens.revoke"] = () => ({ ok: true });
    await click(button(container, "Revoke token name-t1"));
    expect(text(container)).toContain("Revoke this token?");
    expect(bed.called("auth.tokens.revoke")).toEqual([]);
    await click(button(container, "Cancel"));
    expect(text(container)).not.toContain("Revoke this token?");
    await click(button(container, "Revoke token name-t1"));
    bed.handlers["auth.tokens.list"] = () => ({ tokens: [expired] });
    await click(button(container, "Revoke token"));
    await settle();
    const calls = bed.called("auth.tokens.revoke");
    expect(calls.map((call) => call.params)).toEqual([{ tokenId: "t1" }]);
    expect(calls[0]?.options?.commandId).toBe("bed-cmd-00000001");
    expect(bed.called("auth.tokens.list")).toHaveLength(2);
    expect(container.querySelectorAll("[data-token]")).toHaveLength(1);
  });

  it("shows the refusal and reloads", async () => {
    const container = await show();
    bed.handlers["auth.tokens.revoke"] = () => {
      throw new RpcError("not_found");
    };
    await click(button(container, "Revoke token name-t1"));
    await click(button(container, "Revoke token"));
    await settle();
    expect(alerts(container)).toEqual(["Not found."]);
    expect(bed.called("auth.tokens.list")).toHaveLength(2);
  });

  it("does not retry a timeout and says the outcome is unknown", async () => {
    const container = await show();
    bed.handlers["auth.tokens.revoke"] = () => {
      throw new RpcError("timeout");
    };
    await click(button(container, "Revoke token name-t1"));
    await click(button(container, "Revoke token"));
    await settle();
    expect(bed.called("auth.tokens.revoke")).toHaveLength(1);
    expect(alerts(container)[0]).toContain("may still have gone through");
  });
});
