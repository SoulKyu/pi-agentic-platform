// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsProvidersEn as en } from "../../../i18n/catalog/settings-providers.ts";
import type { ProviderView } from "@pap/contracts";
import { button, click, field, hasButton, settle, text, typeInto } from "../../../testing/dom.ts";
import { current, newBed, overviewOf, PROVIDERS, providerButton, show } from "../models-bed.tsx";
import { editableMine, MINE, REVISION } from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const notInFile = { editable: false, reason: "not_in_file", revision: REVISION };

describe("Settings > Models: the provider form is mounted lazily from the list", () => {
  it("has an Add a provider button, and Edit only on models.json providers", async () => {
    newBed();
    const page = await show();
    await settle();
    expect(hasButton(page.container, "Add a provider")).toBe(true);
    const edits = [...page.container.querySelectorAll("button")].filter((one) => one.textContent === "Edit");
    expect(edits.map((one) => one.getAttribute("data-edit-provider"))).toEqual(["mine"]);
  });

  it("Add opens the preset cards, Cancel closes them", async () => {
    const bed = newBed();
    bed.handlers["models.provider.get"] = () => notInFile;
    const page = await show();
    await settle();
    await click(button(page.container, "Add a provider"));
    await vi.waitFor(() => expect(hasButton(page.container, "Custom")).toBe(true), { timeout: 2_000 });
    expect(bed.called("models.provider.get")[0]?.params).toEqual({});
    await click(button(page.container, "Cancel"));
    expect(hasButton(page.container, "Custom")).toBe(false);
  });

  it("Edit opens the form with models.provider.get {id}", async () => {
    const bed = newBed();
    bed.handlers["models.provider.get"] = () => editableMine();
    const page = await show();
    await settle();
    await click(page.container.querySelector('[data-edit-provider="mine"]') as HTMLElement);
    await vi.waitFor(() => expect(hasButton(page.container, "Save")).toBe(true), { timeout: 2_000 });
    expect(bed.called("models.provider.get")[0]?.params).toEqual({ id: "mine" });
  });

  it("a commented models.json disables Add a provider and says why", async () => {
    const bed = newBed();
    bed.handlers["models.overview"] = () => ({ ...overviewOf() });
    bed.handlers["models.refreshCatalog"] = () => ({ offline: false, failedProviders: [], changed: false });
    bed.handlers["models.provider.get"] = () => ({
      editable: false,
      reason: "needs_raw_editor",
      revision: REVISION,
    });
    const page = await show();
    await settle();
    await click(button(page.container, "Add a provider"));
    await vi.waitFor(() => expect(button(page.container, "Add a provider").disabled).toBe(true), {
      timeout: 2_000,
    });
    expect(text(page.container)).toContain(en["settingsProviders.notEditable.needs_raw_editor"]);
  });

  it("the raw-editor link selects a provider whose detail holds the editor", async () => {
    const bed = newBed();
    bed.handlers["models.provider.get"] = () => ({
      editable: false,
      reason: "url_unsupported",
      revision: REVISION,
    });
    const page = await show();
    await settle();
    await click(page.container.querySelector('[data-edit-provider="mine"]') as HTMLElement);
    await vi.waitFor(() => expect(hasButton(page.container, "Open the raw editor")).toBe(true), {
      timeout: 2_000,
    });
    await click(button(page.container, "Open the raw editor"));
    expect(hasButton(page.container, "Open the raw editor")).toBe(false);
    expect(page.container.querySelector('[data-provider-detail="mine"]')).not.toBeNull();
  });

  it("Add is tried again after the list reloads (a fixed file does not leave it off)", async () => {
    const bed = newBed();
    bed.handlers["models.overview"] = () => ({ ...overviewOf() });
    bed.handlers["models.refreshCatalog"] = () => ({ offline: false, failedProviders: [], changed: false });
    bed.handlers["models.provider.get"] = () => ({
      editable: false,
      reason: "needs_raw_editor",
      revision: REVISION,
    });
    const page = await show();
    await settle();
    await click(button(page.container, "Add a provider"));
    await vi.waitFor(() => expect(button(page.container, "Add a provider").disabled).toBe(true), {
      timeout: 2_000,
    });
    await click(button(page.container, "Refresh catalog"));
    await settle();
    expect(button(page.container, "Add a provider").disabled).toBe(false);
  });
});

describe("a dirty draft is never dropped silently (I2)", () => {
  const two = () => {
    const mine2 = { ...PROVIDERS[2], id: "mine2", name: "Mine 2" } as ProviderView;
    const bed = newBed(overviewOf({ providers: [...PROVIDERS, mine2] }));
    bed.handlers["models.provider.get"] = (params) =>
      editableMine({ provider: { ...MINE, id: (params as { id: string }).id } });
    return bed;
  };
  const dirtyForm = async () => {
    const bed = two();
    const page = await show();
    await settle();
    await click(page.container.querySelector('[data-edit-provider="mine"]') as HTMLElement);
    await vi.waitFor(() => expect(hasButton(page.container, "Save")).toBe(true), { timeout: 2_000 });
    await typeInto(field(page.container, "Name") as HTMLInputElement, "Changed");
    return { bed, page };
  };
  const ASK = "Discard your unsaved changes to models.json?";

  it("choosing another provider asks first; Keep editing keeps the draft", async () => {
    const { page } = await dirtyForm();
    await click(providerButton(page.container, "openai"));
    expect(text(page.container)).toContain(ASK);
    await click(button(page.container, "Keep editing"));
    expect(field(page.container, "Name").value).toBe("Changed");
  });

  it("Edit on another provider asks first; Discard opens it", async () => {
    const { bed, page } = await dirtyForm();
    await click(page.container.querySelector('[data-edit-provider="mine2"]') as HTMLElement);
    expect(text(page.container)).toContain(ASK);
    expect(bed.called("models.provider.get")).toHaveLength(1);
    await click(button(page.container, "Discard changes"));
    await vi.waitFor(() => expect(bed.called("models.provider.get")).toHaveLength(2), { timeout: 2_000 });
    expect(bed.called("models.provider.get")[1]?.params).toEqual({ id: "mine2" });
  });

  it("an unchanged form is left without asking", async () => {
    const bed = two();
    const page = await show();
    await settle();
    await click(page.container.querySelector('[data-edit-provider="mine"]') as HTMLElement);
    await vi.waitFor(() => expect(hasButton(page.container, "Save")).toBe(true), { timeout: 2_000 });
    await click(providerButton(page.container, "openai"));
    expect(text(page.container)).not.toContain(ASK);
    expect(bed.called("models.provider.get")).toHaveLength(1);
  });

  it("no prompt after a successful save: the saved draft is not unsaved any more (task 11 carry)", async () => {
    const { bed, page } = await dirtyForm();
    bed.handlers["models.provider.save"] = () => ({ revision: "f".repeat(64), enabledModelsSynced: true });
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("models.provider.save")).toHaveLength(1);
    await click(providerButton(page.container, "openai"));
    expect(text(page.container)).not.toContain(ASK);
  });
});
