// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, click, field, hasButton, settle, text, typeInto } from "../../../testing/dom.ts";
import { current, newBed, show } from "../models-bed.tsx";
import { editableMine, NEXT_REVISION } from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

async function editMine(auth: "stored" | "none" = "stored") {
  const bed = newBed();
  bed.handlers["models.provider.get"] = () =>
    editableMine({ provider: { ...editableMine().provider, auth: { kind: auth } } });
  bed.handlers["models.provider.save"] = () => ({ revision: NEXT_REVISION, enabledModelsSynced: true });
  bed.handlers["models.provider.remove"] = () => ({ revision: NEXT_REVISION, enabledModelsSynced: true });
  const page = await show();
  await settle();
  await click(page.container.querySelector('[data-edit-provider="mine"]') as HTMLElement);
  await vi.waitFor(() => expect(hasButton(page.container, "Save")).toBe(true), { timeout: 2_000 });
  return { bed, page };
}

describe("Settings > Models: the provider flows reload the overview", () => {
  it("a stored save reloads the list at once, offers the key, and Skip leaves for the provider's page", async () => {
    const { bed, page } = await editMine();
    await typeInto(field(page.container, "Name") as HTMLInputElement, "Mine 2");
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("models.overview")).toHaveLength(2);
    expect(text(page.container)).toContain("Provider saved. Add the key.");
    expect(page.container.querySelector("[data-provider-form]")).not.toBeNull();
    await click(button(page.container, "Skip"));
    expect(page.container.querySelector("[data-provider-form]")).toBeNull();
    expect(page.container.querySelector('[data-provider-detail="mine"]')).not.toBeNull();
  });

  it("a save that needs no key closes the form and shows the provider's page", async () => {
    const { bed, page } = await editMine("none");
    await typeInto(field(page.container, "Name") as HTMLInputElement, "Mine 2");
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("models.overview")).toHaveLength(2);
    expect(page.container.querySelector("[data-provider-form]")).toBeNull();
    expect(page.container.querySelector('[data-provider-detail="mine"]')).not.toBeNull();
  });

  it("a remove reloads the list and closes the form", async () => {
    const { bed, page } = await editMine();
    await click(button(page.container, "Remove this provider"));
    await click(button(page.container, "Yes, remove it"));
    await settle();
    expect(bed.called("models.provider.remove")).toHaveLength(1);
    expect(bed.called("models.overview")).toHaveLength(2);
    expect(page.container.querySelector("[data-provider-form]")).toBeNull();
  });
});
