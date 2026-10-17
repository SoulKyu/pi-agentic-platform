// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, click, field, settle, typeInto } from "../../../testing/dom.ts";
import { CUSTOM, current, formBed, pick, showForm, validCustom } from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("form focus and key reload", () => {
  it("opening the form scrolls it into view and focuses its first field", async () => {
    formBed();
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    const { page } = await showForm();
    await settle();
    expect(scroll).toHaveBeenCalled();
    const form = page.container.querySelector("[data-provider-form]") as HTMLElement;
    expect(form.contains(document.activeElement)).toBe(true);
    await pick(page.container, CUSTOM);
    expect(document.activeElement).toBe(form.querySelector("input"));
  });

  it("the key offer focuses its key field, and a stored key tells the host", async () => {
    const bed = formBed();
    bed.handlers["models.setApiKey"] = () => ({ ok: true });
    const { page, spies } = await showForm();
    await settle();
    await pick(page.container, CUSTOM);
    await validCustom(page.container);
    await click(button(page.container, "Save"));
    await settle();
    const key = field(page.container, "API key") as HTMLInputElement;
    expect(document.activeElement).toBe(key);
    expect(spies.keyStored).toEqual([]);
    await typeInto(key, "sk-focus-test-0123456789");
    await click(button(page.container, "Save key"));
    await settle();
    expect(spies.keyStored).toEqual(["mine"]);
  });
});
