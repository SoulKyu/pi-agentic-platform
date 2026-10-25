// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { settle } from "../../testing/dom.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import type { Runtime } from "../../runtime/index.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});
afterEach(() => setLocale("en"));

async function chipText(role: "owner" | "member"): Promise<string | null> {
  current.runtime = fakeRuntime("open").runtime;
  const page = await renderShell("/", { role, username: "ana" });
  await settle();
  const shown = document.querySelector('[data-slot="role-chip"]')?.textContent ?? null;
  await page.unmount();
  return shown;
}

describe("role chip", () => {
  it("the rail shows an OWNER chip", async () => {
    expect(await chipText("owner")).toBe("Owner");
  });
  it("the rail shows a MEMBER chip", async () => {
    expect(await chipText("member")).toBe("Member");
  });
});
