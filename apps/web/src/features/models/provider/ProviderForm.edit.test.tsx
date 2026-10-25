// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsProvidersEn } from "../../../i18n/catalog/settings-providers.ts";
import { setLocale } from "../../../i18n/index.ts";
import { RpcError } from "../../../runtime/index.ts";
import {
  alerts,
  statuses,
  button,
  click,
  field,
  hasButton,
  settle,
  text,
  typeInto,
} from "../../../testing/dom.ts";
import {
  CUSTOM,
  current,
  editableMine,
  formBed,
  formElement,
  MINE,
  MINE_SECRET_HEADER,
  openNew,
  phone,
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
  setLocale("en");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const en = settingsProvidersEn;

describe("saving", () => {
  it("is disabled while a problem exists and sends the exact input with the revision get returned", async () => {
    const saves: unknown[] = [];
    const bed = formBed(undefined, (params) => {
      saves.push(params);
      return { revision: "c".repeat(64), enabledModelsSynced: true };
    });
    const { page, spies } = await showForm();
    await settle();
    await pick(page.container, CUSTOM);
    expect(button(page.container, "Save").disabled).toBe(true);
    await validCustom(page.container);
    expect(button(page.container, "Save").disabled).toBe(false);
    await click(button(page.container, "Save"));
    await settle();
    expect(saves).toEqual([
      {
        mode: "create",
        id: "mine",
        baseRevision: REVISION,
        provider: {
          id: "mine",
          api: "openai-completions",
          baseUrl: "https://api.example.com/v1",
          auth: { kind: "stored" },
          headers: [],
          models: [{ id: "m1" }],
        },
      },
    ]);
    expect(bed.called("models.provider.save")).toHaveLength(1);
    expect(spies.saved).toEqual([{ id: "mine", stored: true }]);
  });

  it("an id that is built in or taken blocks Save and says so", async () => {
    const { page } = await openNew();
    await pick(page.container, "OpenRouter");
    await typeInto(field(page.container, "Identifier") as HTMLInputElement, "anthropic");
    expect(alerts(page.container)).toContain(en["settingsProviders.problem.id.builtin"]);
    await typeInto(field(page.container, "Identifier") as HTMLInputElement, "taken");
    expect(alerts(page.container)).toContain(en["settingsProviders.problem.id.exists"]);
    expect(button(page.container, "Save").disabled).toBe(true);
  });

  it("config_invalid issues light up the matching fields with the fixed phrase", async () => {
    formBed(undefined, () => ({
      code: "config_invalid",
      issues: ["$.provider.id", "$.provider.headers[0]"],
    }));
    const { page, spies } = await showForm();
    await settle();
    await validCustom(page.container);
    await click(button(page.container, "Add a header"));
    await typeInto(field(page.container, "Header name") as HTMLInputElement, "X-Team");
    await typeInto(field(page.container, "Value") as HTMLInputElement, "red");
    await click(button(page.container, "Save"));
    await settle();
    expect(alerts(page.container).filter((one) => one === en["settingsProviders.issue.field"])).toHaveLength(
      2,
    );
    expect(spies.saved).toEqual([]);
  });

  it("a $.file issue gives the raw-editor sentence", async () => {
    formBed(undefined, () => ({ code: "config_invalid", issues: ["$.file"] }));
    const { page } = await showForm();
    await settle();
    await validCustom(page.container);
    await click(button(page.container, "Save"));
    await settle();
    expect(text(page.container)).toContain(en["settingsProviders.notEditable.needs_raw_editor"]);
  });

  it("a failed call keeps the draft and shows the fixed text of the code", async () => {
    formBed(undefined, () => {
      throw new RpcError("conflict");
    });
    const { page } = await showForm();
    await settle();
    await validCustom(page.container);
    await click(button(page.container, "Save"));
    await settle();
    expect(alerts(page.container).length).toBe(1);
    expect(field(page.container, "Identifier").value).toBe("mine");
  });
});

describe("editing", () => {
  it("opens with models.provider.get {id}, fills the draft, locks the id and shows kept values", async () => {
    const bed = formBed(() => editableMine({ advanced: true }));
    const { page } = await showForm({ id: "mine" });
    await settle();
    expect(bed.called("models.provider.get")[0]?.params).toEqual({ id: "mine" });
    expect(field(page.container, "Name").value).toBe("Mine");
    expect(field(page.container, "Identifier").disabled).toBe(true);
    expect(field(page.container, "Base URL").value).toBe("https://api.example.com/v1");
    expect(field(page.container, "Model id").value).toBe("m1");
    expect(text(page.container)).toContain(en["settingsProviders.advanced.note"]);
    expect(text(page.container)).toContain(en["settingsProviders.headers.kept"]);
    expect(hasButton(page.container, "Replace")).toBe(true);
    expect(page.container.querySelector('[data-slot="preset-cards"]')).toBeNull();
  });

  it("does not show the advanced note when the provider has none", async () => {
    formBed(() => editableMine());
    const { page } = await showForm({ id: "mine" });
    await settle();
    expect(text(page.container)).not.toContain(en["settingsProviders.advanced.note"]);
  });

  it("sends mode update with a kept header as keep, the id unchanged and the revision it read", async () => {
    const saves: Array<{ mode: string; baseRevision: string; provider: { headers: unknown[] } }> = [];
    formBed(
      () => editableMine(),
      (params) => {
        saves.push(params as (typeof saves)[number]);
        return { revision: "c".repeat(64), enabledModelsSynced: true };
      },
    );
    const { page, spies } = await showForm({ id: "mine" });
    await settle();
    await typeInto(field(page.container, "Name") as HTMLInputElement, "Mine 2");
    await click(button(page.container, "Save"));
    await settle();
    expect(saves[0]?.mode).toBe("update");
    expect(saves[0]?.baseRevision).toBe(REVISION);
    expect(saves[0]?.provider.headers[0]).toEqual({ name: "X-Org", value: { kind: "keep" } });
    expect(spies.saved).toEqual([{ id: "mine", stored: true }]);
  });

  it("Replace turns a kept header into a value the owner types", async () => {
    formBed(() => editableMine());
    const { page } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, "Replace"));
    expect(hasButton(page.container, "Replace")).toBe(false);
    expect(field(page.container, "Value")).toBeTruthy();
  });
});

describe("form.not-editable.* (MP-RT-02, MP-RT-18)", () => {
  it.each(["needs_raw_editor", "url_unsupported", "api_unsupported", "builtin", "not_in_file"] as const)(
    "%s shows its sentence, the raw-editor link and no field",
    async (reason) => {
      formBed(() => ({ editable: false, reason, revision: REVISION }));
      const { page, spies } = await showForm({ id: "mine" });
      await settle();
      expect(text(page.container)).toContain(
        en[`settingsProviders.notEditable.${reason}` as keyof typeof en],
      );
      expect(
        page.container.querySelectorAll("input, textarea, [role='switch'], [role='combobox']"),
      ).toHaveLength(0);
      if (reason !== "not_in_file") {
        await click(button(page.container, "Open the raw editor"));
        expect(spies.raw).toEqual(["mine"]);
      }
    },
  );

  it("says the French sentences of the brief with vous", async () => {
    setLocale("fr");
    formBed(() => ({ editable: false, reason: "needs_raw_editor", revision: REVISION }));
    const { page } = await showForm({ id: "mine" });
    await settle();
    expect(text(page.container)).toContain(
      "Ce fichier contient des commentaires ou des virgules finales, ou ce fournisseur utilise des réglages que le formulaire ne couvre pas\u202f: modifiez-le dans l'éditeur brut",
    );
  });

  it("a commented file on a new provider shows the sentence, no preset and tells the list to block Add", async () => {
    formBed(() => ({ editable: false, reason: "needs_raw_editor", revision: REVISION }));
    const { page, spies } = await showForm();
    await settle();
    expect(text(page.container)).toContain(en["settingsProviders.notEditable.needs_raw_editor"]);
    expect(hasButton(page.container, CUSTOM)).toBe(false);
    expect(spies.commented).toEqual([true]);
  });

  it("a clean file tells the list that Add is open", async () => {
    const { spies } = await openNew();
    expect(spies.commented).toEqual([false]);
  });
});

describe("failures and the guard", () => {
  it("unknown_method shows the reload message and a Reload button", async () => {
    formBed(() => {
      throw new RpcError("unknown_method");
    });
    const { page } = await showForm();
    await settle();
    expect(statuses(page.container)).toContain(
      "This version of the page does not match the server. Reload it.",
    );
    expect(hasButton(page.container, "Reload")).toBe(true);
  });

  it("another failure offers Try again that reads again", async () => {
    let calls = 0;
    const bed = formBed(() => {
      calls += 1;
      if (calls === 1) throw new RpcError("timeout");
      return { editable: false, reason: "not_in_file", revision: REVISION };
    });
    const { page } = await showForm();
    await settle();
    await click(button(page.container, "Try again"));
    await settle();
    expect(bed.called("models.provider.get")).toHaveLength(2);
    expect(hasButton(page.container, CUSTOM)).toBe(true);
  });

  it("Cancel closes at once when nothing changed and asks first when something did", async () => {
    const { page, spies } = await openNew();
    await pick(page.container, CUSTOM);
    await click(button(page.container, "Cancel"));
    expect(spies.closed).toHaveLength(1);
  });

  it("asks before discarding a changed draft (DiscardConfirm)", async () => {
    formBed(() => editableMine());
    const { page, spies } = await showForm({ id: "mine" });
    await settle();
    await typeInto(field(page.container, "Name") as HTMLInputElement, "Other");
    await click(button(page.container, "Cancel"));
    expect(spies.closed).toHaveLength(0);
    expect(text(page.container)).toContain("Discard your unsaved changes to models.json?");
    await click(button(page.container, "Keep editing"));
    expect(field(page.container, "Name").value).toBe("Other");
    await click(button(page.container, "Cancel"));
    await click(button(page.container, "Discard changes"));
    expect(spies.closed).toHaveLength(1);
  });
});

describe("phone layout", () => {
  it("stacks the sections and keeps 44 px controls", async () => {
    phone(true);
    const { page } = await openNew();
    await pick(page.container, CUSTOM);
    const form = page.container.querySelector("[data-provider-form]") as HTMLElement;
    expect(form.getAttribute("data-layout")).toBe("stack");
    for (const control of page.container.querySelectorAll("button, input")) {
      expect(control.className, control.textContent ?? control.id).toContain("pointer-coarse:min-h-11");
    }
  });

  it("uses the wide layout on a desktop", async () => {
    phone(false);
    const { page } = await openNew();
    await pick(page.container, CUSTOM);
    expect(
      (page.container.querySelector("[data-provider-form]") as HTMLElement).getAttribute("data-layout"),
    ).toBe("wide");
  });
});

describe("kept headers (I1, MPR-C4)", () => {
  it("Replace on a secret-named kept header leads to an environment variable, never a dead end", async () => {
    formBed(() => editableMine({ provider: MINE_SECRET_HEADER }));
    const { page } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, "Replace"));
    expect(field(page.container, "Header variable name").value).toBe("");
    expect(() => field(page.container, "Value")).toThrow();
  });

  it("the name of a kept header is locked until its value is replaced", async () => {
    formBed(() => editableMine());
    const { page } = await showForm({ id: "mine" });
    await settle();
    const name = () =>
      page.container.querySelector('[data-header-row="headers.0"] input') as HTMLInputElement;
    expect(name().value).toBe("X-Org");
    expect(name().disabled).toBe(true);
    await click(button(page.container, "Replace"));
    expect(name().disabled).toBe(false);
  });
});

describe("switching target (I3)", () => {
  it("Edit A then Edit B: while B loads, A's draft is gone and Save is off; B's answer fills it", async () => {
    const waiting: Array<(value: unknown) => void> = [];
    formBed((params) =>
      params.id === "b" ? new Promise((resolve) => waiting.push(resolve)) : editableMine(),
    );
    const { page } = await showForm({ id: "mine" });
    await settle();
    expect(field(page.container, "Name").value).toBe("Mine");
    await page.rerender(formElement({ id: "b" }));
    expect(text(page.container)).not.toContain("Mine");
    expect(hasButton(page.container, "Save")).toBe(false);
    waiting[0]?.(editableMine({ provider: { ...MINE, id: "b", name: "Bee" } }));
    await settle();
    expect(field(page.container, "Name").value).toBe("Bee");
    expect(button(page.container, "Save").disabled).toBe(false);
  });
});
