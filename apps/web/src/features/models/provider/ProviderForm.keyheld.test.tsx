// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { button, click, field, settle, text, typeInto } from "../../../testing/dom.ts";
import {
  CUSTOM,
  current,
  editableMine,
  formBed,
  MINE,
  pick,
  REVISION,
  showForm,
} from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

const OVERRIDE = "already stored for this provider";
const REUSED = "already stored under this identifier";

describe("a stored key outranks the environment variable and 'No key' (I1)", () => {
  it("editing a provider whose key is stored: env or none says Pi uses the stored key and points to Sign out", async () => {
    formBed(() => editableMine({ keyStored: true }));
    const { page } = await showForm({ id: "mine" });
    await settle();
    expect(text(page.container)).not.toContain(OVERRIDE); // stored key + "Stored key": nothing to warn about
    await click(button(page.container, "Environment variable"));
    expect(text(page.container)).toContain(OVERRIDE);
    expect(text(page.container)).toContain("Sign out");
    await click(button(page.container, "No key"));
    expect(text(page.container)).toContain(OVERRIDE);
  });

  it("says nothing when no key is stored", async () => {
    formBed(() => editableMine());
    const { page } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, "Environment variable"));
    expect(text(page.container)).not.toContain(OVERRIDE);
  });

  it("creating: an identifier that auth.json already holds a key for warns, whatever the auth choice", async () => {
    formBed((params) =>
      params.id === undefined
        ? { editable: false, reason: "not_in_file", revision: REVISION, storedKeys: ["old"] }
        : editableMine({ revision: REVISION, provider: { ...MINE, id: params.id } }),
    );
    const { page } = await showForm();
    await settle();
    await pick(page.container, CUSTOM);
    await typeInto(field(page.container, "Identifier") as HTMLInputElement, "fresh");
    expect(text(page.container)).not.toContain(REUSED);
    await typeInto(field(page.container, "Identifier") as HTMLInputElement, "old");
    expect(text(page.container)).toContain(REUSED);
    await click(button(page.container, "No key"));
    expect(text(page.container)).toContain(REUSED);
  });

  it("the copy claims no more than Pi does, in English and in French", async () => {
    formBed();
    const en = await showForm();
    await settle();
    await pick(en.page.container, CUSTOM);
    await click(button(en.page.container, "Environment variable"));
    expect(text(en.page.container)).not.toContain("The daemon reads this variable");
    await click(button(en.page.container, "No key"));
    expect(text(en.page.container)).not.toContain("No key is needed");
    await en.page.unmount();
    setLocale("fr");
    const fr = await showForm();
    await settle();
    await pick(fr.page.container, "Personnalisé");
    await click(button(fr.page.container, "Variable d'environnement"));
    expect(text(fr.page.container)).not.toContain("Le démon lit cette variable");
    await click(button(fr.page.container, "Pas de clé"));
    expect(text(fr.page.container)).not.toContain("Aucune clé n'est nécessaire");
  });
});
