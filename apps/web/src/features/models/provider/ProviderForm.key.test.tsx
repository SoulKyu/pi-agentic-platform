// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../../runtime/index.ts";
import { button, click, field, settle, typeInto } from "../../../testing/dom.ts";
import { CUSTOM, current, formBed, pick, showForm, validCustom } from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

const MARKER = "sk-marker-7f3a9c1e5b2d";

async function offered(failKey = false) {
  const bed = formBed();
  bed.handlers["models.setApiKey"] = () => {
    if (failKey) throw new RpcError("timeout");
    return { ok: true };
  };
  const shown = await showForm();
  await settle();
  await pick(shown.page.container, CUSTOM);
  await validCustom(shown.page.container);
  await click(button(shown.page.container, "Save"));
  await settle();
  return { bed, ...shown };
}

/** Everywhere a typed key could stay behind in the page (the brief's list). */
function nowhere(container: HTMLElement) {
  for (const input of document.querySelectorAll("input, textarea"))
    expect((input as HTMLInputElement).value).not.toContain(MARKER);
  expect(document.body.innerHTML).not.toContain(MARKER);
  expect(container.textContent).not.toContain(MARKER);
  for (const store of [localStorage, sessionStorage])
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i) ?? "";
      expect(key).not.toContain(MARKER);
      expect(store.getItem(key)).not.toContain(MARKER);
    }
  expect(JSON.stringify(window.history.state ?? null)).not.toContain(MARKER);
}

describe("key.marker.nowhere (web side)", () => {
  it("a key typed after a save goes only into models.setApiKey, and is gone after submit", async () => {
    const { bed, page } = await offered();
    await typeInto(field(page.container, "API key") as HTMLInputElement, MARKER);
    await click(button(page.container, "Save key"));
    await settle();
    const carrying = bed.calls.filter((call) => JSON.stringify(call.params).includes(MARKER));
    expect(carrying.map((call) => call.method)).toEqual(["models.setApiKey"]);
    nowhere(page.container);
  });

  it("is gone after a failed submit", async () => {
    const { page } = await offered(true);
    await typeInto(field(page.container, "API key") as HTMLInputElement, MARKER);
    await click(button(page.container, "Save key"));
    await settle();
    expect((field(page.container, "API key") as HTMLInputElement).value).toBe("");
    nowhere(page.container);
  });

  it("is gone after an unmount with the key still typed", async () => {
    const { bed, page } = await offered();
    await typeInto(field(page.container, "API key") as HTMLInputElement, MARKER);
    await page.unmount();
    expect(bed.calls.filter((call) => JSON.stringify(call.params).includes(MARKER))).toEqual([]);
    nowhere(page.container);
  });

  it("the provider form itself never holds it: no password input before the save", async () => {
    formBed();
    const { page } = await showForm();
    await settle();
    await pick(page.container, CUSTOM);
    expect(page.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it("sign-out: the settings tree unmounts, and a remount starts with an empty key field", async () => {
    const { page } = await offered();
    await typeInto(field(page.container, "API key") as HTMLInputElement, MARKER);
    await page.unmount();
    nowhere(page.container);
    const again = await showForm();
    await settle();
    await pick(again.page.container, CUSTOM);
    await validCustom(again.page.container);
    await click(button(again.page.container, "Save"));
    await settle();
    expect((field(again.page.container, "API key") as HTMLInputElement).value).toBe("");
    nowhere(again.page.container);
  });
});
