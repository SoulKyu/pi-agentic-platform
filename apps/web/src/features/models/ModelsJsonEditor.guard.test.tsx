// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, click, field, hasButton, settle, text, typeInto } from "../../testing/dom.ts";
import {
  current,
  model,
  newBed,
  overviewOf,
  PROVIDERS,
  prompt,
  providerButton,
  show,
} from "./models-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const REVISION = "a".repeat(64);
const NEXT_REVISION = "b".repeat(64);
const MASKED = '{\n  "providers": {\n    "mine": { "apiKey": "<redacted:1>", "models": [] }\n  }\n}\n';

beforeEach(() => {
  prompt.answer = true;
  prompt.asked = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function openEditor() {
  const bed = newBed(
    overviewOf({
      providers: PROVIDERS.map((one) =>
        one.id === "mine" ? { ...one, models: [model("mine", "m-1", true)] } : one,
      ),
    }),
  );
  bed.handlers["models.config.get"] = () => ({
    path: "/a/models.json",
    text: MASKED,
    issues: [],
    revision: REVISION,
  });
  const page = await show();
  await settle();
  await click(providerButton(page.container, "mine"));
  await click(button(page.container, "Edit models.json"));
  await settle();
  return { bed, page };
}

const editor = (container: ParentNode) => field(container, "models.json") as HTMLTextAreaElement;

describe("unsaved edits", () => {
  it("closes at once when nothing was changed", async () => {
    const { page } = await openEditor();
    await click(button(page.container, "Close the editor"));
    expect(hasButton(page.container, "Save models.json")).toBe(false);
    expect(text(page.container)).not.toContain("Discard your unsaved changes");
  });

  it("asks before closing the editor over edits, and keeps them on Keep editing", async () => {
    const { page } = await openEditor();
    await typeInto(editor(page.container), "{ my edit }");
    await click(button(page.container, "Close the editor"));
    expect(text(page.container)).toContain("Discard your unsaved changes to models.json?");
    await click(button(page.container, "Keep editing"));
    expect(editor(page.container).value).toBe("{ my edit }");
    expect(text(page.container)).not.toContain("Discard your unsaved changes");
    await click(button(page.container, "Close the editor"));
    await click(button(page.container, "Discard changes"));
    expect(hasButton(page.container, "Save models.json")).toBe(false);
  });

  it("asks before another provider replaces the one being edited", async () => {
    const { page } = await openEditor();
    await typeInto(editor(page.container), "{ my edit }");
    await click(providerButton(page.container, "openai"));
    expect(page.container.querySelector('[data-provider-detail="mine"]')).not.toBeNull();
    expect(text(page.container)).toContain("Discard your unsaved changes to models.json?");
    await click(button(page.container, "Keep editing"));
    expect(editor(page.container).value).toBe("{ my edit }");
    await click(providerButton(page.container, "openai"));
    await click(button(page.container, "Discard changes"));
    expect(page.container.querySelector('[data-provider-detail="openai"]')).not.toBeNull();
    expect(page.container.querySelector('[data-provider-detail="mine"]')).toBeNull();
  });

  it("switches at once when the text is unchanged, and after a save", async () => {
    const { bed, page } = await openEditor();
    await click(providerButton(page.container, "openai"));
    expect(page.container.querySelector('[data-provider-detail="openai"]')).not.toBeNull();
    await click(providerButton(page.container, "mine"));
    await click(button(page.container, "Edit models.json"));
    await settle();
    await typeInto(editor(page.container), "{}");
    bed.handlers["models.config.save"] = () => ({ revision: NEXT_REVISION, enabledModelsSynced: true });
    bed.handlers["models.config.get"] = () => ({
      path: "/a/models.json",
      text: "{}",
      issues: [],
      revision: NEXT_REVISION,
    });
    await click(button(page.container, "Save models.json"));
    await settle();
    await click(providerButton(page.container, "openai"));
    expect(page.container.querySelector('[data-provider-detail="openai"]')).not.toBeNull();
  });
});

describe("a save in flight", () => {
  it("keeps the field read-only until the save and the re-read are over", async () => {
    const { bed, page } = await openEditor();
    let finish: (value: unknown) => void = () => {};
    bed.handlers["models.config.save"] = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await typeInto(editor(page.container), "{ a }");
    await click(button(page.container, "Save models.json"));
    expect(editor(page.container).disabled).toBe(true);
    await act(async () => finish({ revision: NEXT_REVISION, enabledModelsSynced: true }));
    await settle();
    expect(editor(page.container).disabled).toBe(false);
  });
});
