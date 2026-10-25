// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsProvidersEn as en } from "../../../i18n/catalog/settings-providers.ts";
import { RpcError } from "../../../runtime/index.ts";
import { alerts, button, click, field, hasButton, settle, text, typeInto } from "../../../testing/dom.ts";
import {
  CUSTOM,
  current,
  editableMine,
  formBed,
  NEXT_REVISION,
  OLLAMA,
  pick,
  REVISION,
  showForm,
  validCustom,
} from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const SAVED = "Provider saved. Add the key.";
const FILE_CHANGED = "The file changed; check, then save again.";
const methods = (bed: ReturnType<typeof formBed>) => bed.calls.map((call) => call.method);

async function createCustom(bed = formBed()) {
  const shown = await showForm();
  await settle();
  await pick(shown.page.container, CUSTOM);
  await validCustom(shown.page.container);
  await click(button(shown.page.container, "Save"));
  await settle();
  return { bed, ...shown };
}

describe("save.revision-from-get", () => {
  it("reads once when the form opens, saves with that revision, reloads, and never reads the config", async () => {
    const bed = formBed();
    const { page } = await createCustom(bed);
    expect(methods(bed)).toEqual(["models.provider.get", "models.provider.save", "models.provider.get"]);
    expect(bed.called("models.config.get")).toHaveLength(0);
    expect((bed.called("models.provider.save")[0]?.params as { baseRevision: string }).baseRevision).toBe(
      REVISION,
    );
    expect(bed.called("models.provider.get")[1]?.params).toEqual({ id: "mine" });
    expect(text(page.container)).toContain(SAVED);
  });
});

describe("the key is offered after a stored save", () => {
  it("shows the existing ApiKeyForm for that provider; Skip leaves the provider without a key", async () => {
    const bed = formBed();
    const { page, spies } = await createCustom(bed);
    expect(spies.saved).toEqual([{ id: "mine", stored: true }]);
    expect(field(page.container, "API key").getAttribute("autocomplete")).toBe("off");
    expect(spies.finished).toEqual([]);
    await click(button(page.container, "Skip"));
    expect(spies.finished).toEqual(["mine"]);
    expect(bed.called("models.setApiKey")).toHaveLength(0);
  });

  it("a saved key ends the form", async () => {
    const bed = formBed();
    const { page, spies } = await createCustom(bed);
    await typeInto(field(page.container, "API key") as HTMLInputElement, "sk-test-value");
    await click(button(page.container, "Save key"));
    await settle();
    expect(bed.called("models.setApiKey")[0]?.params).toEqual({ provider: "mine", key: "sk-test-value" });
    expect(spies.finished).toEqual(["mine"]);
  });

  it("a provider that needs no key finishes at once, with no key form", async () => {
    formBed();
    const { page, spies } = await showForm();
    await settle();
    await pick(page.container, OLLAMA);
    await click(button(page.container, "Add a model"));
    await typeInto(field(page.container, "Model id") as HTMLInputElement, "llama3");
    await click(button(page.container, "Save"));
    await settle();
    expect(spies.saved).toEqual([{ id: "ollama", stored: false }]);
    expect(spies.finished).toEqual(["ollama"]);
    expect(page.container.querySelector('[name="api-key"]')).toBeNull();
  });
});

describe("save.conflict-reloads", () => {
  const conflictBed = () => {
    const reads: number[] = [];
    const saves: Array<{ baseRevision: string }> = [];
    const bed = formBed(
      () => {
        reads.push(1);
        return editableMine({ revision: reads.length === 1 ? REVISION : "d".repeat(64) });
      },
      (params) => {
        saves.push(params as (typeof saves)[number]);
        if (saves.length === 1) throw new RpcError("conflict");
        return { revision: NEXT_REVISION, enabledModelsSynced: true };
      },
    );
    return { bed, reads, saves };
  };

  it("a failed provider save is an alert", async () => {
    const bed = formBed();
    bed.handlers["models.provider.save"] = () => {
      throw new RpcError("helper_failed");
    };
    const { page } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, "Save"));
    await settle();
    expect(
      page.container.querySelectorAll('[data-slot="inline-error"][role="alert"]').length,
    ).toBeGreaterThan(0);
  });

  it("reloads with provider.get, keeps the draft, says so, and the next save carries the new revision", async () => {
    const { bed, saves } = conflictBed();
    const { page, spies } = await showForm({ id: "mine" });
    await settle();
    await typeInto(field(page.container, "Name") as HTMLInputElement, "My draft");
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("models.provider.get")).toHaveLength(2);
    expect(field(page.container, "Name").value).toBe("My draft");
    expect(alerts(page.container)).toContain(FILE_CHANGED);
    expect(spies.saved).toEqual([]);
    await click(button(page.container, "Save"));
    await settle();
    expect(saves.map((one) => one.baseRevision)).toEqual([REVISION, "d".repeat(64)]);
    expect(spies.saved).toEqual([{ id: "mine", stored: true }]);
  });

  it("offers the file's version, and takes it only when asked", async () => {
    conflictBed();
    const { page } = await showForm({ id: "mine" });
    await settle();
    await typeInto(field(page.container, "Name") as HTMLInputElement, "My draft");
    await click(button(page.container, "Save"));
    await settle();
    expect(field(page.container, "Name").value).toBe("My draft");
    await click(button(page.container, "Show the file's version"));
    expect(field(page.container, "Name").value).toBe("Mine");
    expect(alerts(page.container)).not.toContain(FILE_CHANGED);
  });

  it("keeps the draft even when the reload itself fails", async () => {
    let reads = 0;
    formBed(
      () => {
        reads += 1;
        if (reads > 1) throw new RpcError("timeout");
        return editableMine();
      },
      () => {
        throw new RpcError("conflict");
      },
    );
    const { page } = await showForm({ id: "mine" });
    await settle();
    await typeInto(field(page.container, "Name") as HTMLInputElement, "My draft");
    await click(button(page.container, "Save"));
    await settle();
    expect(field(page.container, "Name").value).toBe("My draft");
    expect(alerts(page.container).length).toBeGreaterThan(0);
  });
});

describe("save failures", () => {
  it("step-up cancelled sends nothing", async () => {
    const bed = formBed();
    const { page, spies } = await showForm({}, { stepUp: async () => null });
    await settle();
    await pick(page.container, CUSTOM);
    await validCustom(page.container);
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("models.provider.save")).toHaveLength(0);
    expect(spies.saved).toEqual([]);
    expect(button(page.container, "Save").disabled).toBe(false);
  });

  it("a $.file issue gives the comments sentence and keeps the draft", async () => {
    formBed(undefined, () => ({ code: "config_invalid", issues: ["$.file"] }));
    const { page } = await showForm();
    await settle();
    await pick(page.container, CUSTOM);
    await validCustom(page.container);
    await click(button(page.container, "Save"));
    await settle();
    expect(alerts(page.container)).toContain(en["settingsProviders.notEditable.needs_raw_editor"]);
    expect(field(page.container, "Identifier").value).toBe("mine");
  });

  it("unknown_method asks to reload and sends nothing twice", async () => {
    const bed = formBed(undefined, () => {
      throw new RpcError("unknown_method");
    });
    const { page } = await showForm();
    await settle();
    await pick(page.container, CUSTOM);
    await validCustom(page.container);
    await click(button(page.container, "Save"));
    await settle();
    expect(alerts(page.container)).toContain(
      "This version of the page does not match the server. Reload it.",
    );
    expect(hasButton(page.container, "Reload")).toBe(true);
    expect(hasButton(page.container, "Save")).toBe(false);
    expect(bed.called("models.provider.save")).toHaveLength(1);
  });

  it("a failed reload after a good save says so and keeps the form", async () => {
    let reads = 0;
    formBed(() => {
      reads += 1;
      if (reads > 1) throw new RpcError("timeout");
      return { editable: false, reason: "not_in_file", revision: REVISION };
    });
    const { page, spies } = await showForm();
    await settle();
    await pick(page.container, CUSTOM);
    await validCustom(page.container);
    await click(button(page.container, "Save"));
    await settle();
    expect(spies.saved).toEqual([{ id: "mine", stored: true }]);
    expect(alerts(page.container).length).toBeGreaterThan(0);
    expect(text(page.container)).toContain(SAVED);
  });
});
