// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { alerts, button, click, field, hasButton, settle, text, typeInto } from "../../testing/dom.ts";
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
  sessionStorage.clear();
  localStorage.clear();
  prompt.answer = true;
  prompt.asked = 0;
});
afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

const MINE_WITH_MODELS = overviewOf({
  providers: PROVIDERS.map((one) =>
    one.id === "mine" ? { ...one, models: [model("mine", "m-1", true), model("mine", "m-2", true)] } : one,
  ),
});

async function openEditor(id = "mine", config: unknown = { text: MASKED, issues: [], revision: REVISION }) {
  const bed = newBed(MINE_WITH_MODELS);
  bed.handlers["models.config.get"] = () => ({ path: "/a/models.json", ...(config as object) });
  const page = await show();
  await settle();
  await click(providerButton(page.container, id));
  await click(button(page.container, "Edit models.json"));
  await settle();
  return { bed, page };
}

const editor = (container: ParentNode) => field(container, "models.json") as HTMLTextAreaElement;

describe("loading and saving", () => {
  it("shows the masked text, the note about placeholders, and keeps the text out of every browser store", async () => {
    const { page } = await openEditor();
    expect(editor(page.container).value).toBe(MASKED);
    expect(text(page.container)).toContain(
      "Secrets show as <redacted:N>. Leave them as they are to keep them; replace one to change it.",
    );
    expect(text(page.container)).toContain("/a/models.json");
    await typeInto(editor(page.container), `${MASKED}\n// typed`);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(location.href).not.toContain("typed");
    expect(location.hash).toBe("");
  });

  it("saves the text as shown with the revision it read, after the password step-up, and reads the providers again", async () => {
    const { bed, page } = await openEditor();
    let attempts = 0;
    bed.handlers["models.config.save"] = () => {
      attempts += 1;
      if (attempts === 1) throw new RpcError("step_up_required");
      return { revision: NEXT_REVISION, enabledModelsSynced: true };
    };
    const overviewsBefore = bed.called("models.overview").length;
    const edited = `${MASKED}// note\n`;
    bed.handlers["models.config.get"] = () => ({
      path: "/a/models.json",
      text: edited,
      issues: [],
      revision: NEXT_REVISION,
    });
    await typeInto(editor(page.container), edited);
    await click(button(page.container, "Save models.json"));
    await settle();
    const saves = bed.called("models.config.save");
    expect(saves.map((call) => call.params)).toEqual([
      { text: edited, baseRevision: REVISION },
      { text: edited, baseRevision: REVISION },
    ]);
    expect(prompt.asked).toBe(1);
    expect(text(page.container)).toContain("models.json saved.");
    expect(bed.called("models.overview").length).toBe(overviewsBefore + 1);
    // The file is read again after the save, and the next save is based on the revision of that read.
    expect(bed.called("models.config.get").length).toBe(2);
    bed.handlers["models.config.save"] = () => ({ revision: REVISION, enabledModelsSynced: true });
    await typeInto(editor(page.container), `${edited}// again\n`);
    await click(button(page.container, "Save models.json"));
    await settle();
    expect(bed.called("models.config.save").at(-1)?.params).toEqual({
      text: `${edited}// again\n`,
      baseRevision: NEXT_REVISION,
    });
  });

  it("does nothing when the password prompt is cancelled", async () => {
    const { bed, page } = await openEditor();
    prompt.answer = false;
    bed.handlers["models.config.save"] = () => {
      throw new RpcError("step_up_required");
    };
    await typeInto(editor(page.container), "{}");
    await click(button(page.container, "Save models.json"));
    await settle();
    expect(bed.called("models.config.save").length).toBe(1);
    expect(editor(page.container).value).toBe("{}");
    expect(alerts(page.container)).toEqual([]);
  });

  it("says when the list in settings.json could not follow the save", async () => {
    const { bed, page } = await openEditor();
    bed.handlers["models.config.save"] = () => ({ revision: NEXT_REVISION, enabledModelsSynced: false });
    await typeInto(editor(page.container), "{}");
    await click(button(page.container, "Save models.json"));
    await settle();
    expect(text(page.container)).toContain("models.json saved, but");
  });

  it("marks the refused places as JSON paths and keeps the draft", async () => {
    const { bed, page } = await openEditor();
    bed.handlers["models.config.save"] = () => ({
      code: "config_invalid",
      issues: ["providers.mine.models[0].id", "line 3, column 9: masked_value_moved"],
    });
    await typeInto(editor(page.container), "{ draft }");
    await click(button(page.container, "Save models.json"));
    await settle();
    const body = text(page.container);
    expect(body).toContain("providers.mine.models[0].id");
    expect(body).toContain("line 3, column 9: masked_value_moved");
    expect(editor(page.container).value).toBe("{ draft }");
    expect(editor(page.container).getAttribute("aria-invalid")).toBe("true");
  });

  it("offers Reload on a conflict, keeps the owner's draft, and never overwrites on its own", async () => {
    const { bed, page } = await openEditor();
    bed.handlers["models.config.save"] = () => {
      throw new RpcError("conflict");
    };
    await typeInto(editor(page.container), "{ my draft }");
    await click(button(page.container, "Save models.json"));
    await settle();
    expect(text(page.container)).toContain("changed since you opened it");
    expect(editor(page.container).value).toBe("{ my draft }");
    expect(bed.called("models.config.get").length).toBe(1);
    bed.handlers["models.config.get"] = () => ({
      path: "/a/models.json",
      text: "{ disk }",
      issues: [],
      revision: NEXT_REVISION,
    });
    await click(button(page.container, "Reload from disk"));
    await settle();
    expect(editor(page.container).value).toBe("{ disk }");
    expect(bed.called("models.config.save").length).toBe(1);
  });

  it("does not show a file that does not parse and offers to replace the whole content", async () => {
    const { bed, page } = await openEditor("mine", {
      text: null,
      issues: ["line 2, column 5: unexpected token"],
      revision: REVISION,
    });
    expect(text(page.container)).toContain("line 2, column 5: unexpected token");
    expect(text(page.container)).toContain("does not parse");
    expect(() => editor(page.container)).toThrow();
    await click(button(page.container, "Replace the whole content"));
    const starter = editor(page.container).value;
    expect(JSON.parse(starter)).toEqual({ providers: {} });
    bed.handlers["models.config.save"] = () => ({ revision: NEXT_REVISION, enabledModelsSynced: true });
    await click(button(page.container, "Save models.json"));
    await settle();
    expect(bed.called("models.config.save")[0]?.params).toEqual({ text: starter, baseRevision: REVISION });
  });

  it("starts from an empty document when there is no file yet", async () => {
    const { page } = await openEditor("mine", { text: null, issues: [], revision: REVISION });
    expect(text(page.container)).toContain("There is no models.json yet");
    expect(JSON.parse(editor(page.container).value)).toEqual({ providers: {} });
  });

  it("shows a failed read as its fixed text", async () => {
    const bed = newBed(MINE_WITH_MODELS);
    bed.handlers["models.config.get"] = () => {
      throw new RpcError("helper_failed");
    };
    const page = await show();
    await settle();
    await click(providerButton(page.container, "mine"));
    await click(button(page.container, "Edit models.json"));
    await settle();
    expect(alerts(page.container).length).toBe(1);
    expect(hasButton(page.container, "Save models.json")).toBe(false);
  });
});

const tick = (container: ParentNode, id: string) => {
  const box = [...container.querySelectorAll('[data-slot="checkbox"]')]
    .find((one) => one.textContent === id)
    ?.querySelector('[role="checkbox"]');
  if (!box) throw new Error(`no checkbox ${id}`);
  return click(box);
};

describe("discover", () => {
  it("is not offered for the built-in Anthropic provider", async () => {
    const { page } = await openEditor("anthropic");
    expect(hasButton(page.container, "Discover models")).toBe(false);
  });

  it("lists what the provider offers and adds the ticked models to the text without saving", async () => {
    const { bed, page } = await openEditor();
    bed.handlers["models.discover"] = () => ({
      models: [{ id: "d-1", contextWindow: 4096 }, { id: "d-2" }, { id: "d-3", reasoning: true }],
    });
    await click(button(page.container, "Discover models"));
    await settle();
    expect(bed.called("models.discover")[0]?.params).toEqual({ provider: "mine" });
    expect(bed.called("models.discover")[0]?.options?.commandId).toBe("stub-command");
    expect(text(page.container)).toContain("Nothing is saved until you save the text.");
    await tick(page.container, "d-1");
    await tick(page.container, "d-3");
    await click(button(page.container, "Add 2 selected to the text"));
    const value = editor(page.container).value;
    expect(value).toContain('"id":"d-1"');
    expect(value).toContain('"id":"d-3"');
    expect(value).not.toContain("d-2");
    expect(value).toContain('"apiKey": "<redacted:1>"');
    expect(bed.called("models.config.save").length).toBe(0);
    expect(text(page.container)).toContain("Added 2 models to the text");
  });

  it("asks again when the password prompt is needed, and stops quietly when it is cancelled", async () => {
    const { bed, page } = await openEditor();
    prompt.answer = false;
    bed.handlers["models.discover"] = () => {
      throw new RpcError("step_up_required");
    };
    await click(button(page.container, "Discover models"));
    await settle();
    expect(prompt.asked).toBe(1);
    expect(alerts(page.container)).toEqual([]);
  });

  it.each([
    ["http_4xx", "refused the request"],
    ["http_5xx", "server failed"],
    ["network", "could not be reached"],
    ["timeout", "did not answer in time"],
  ] as const)("says what the %s code means", async (code, phrase) => {
    const { bed, page } = await openEditor();
    bed.handlers["models.discover"] = () => ({ models: [], code });
    await click(button(page.container, "Discover models"));
    await settle();
    expect(alerts(page.container).join(" ")).toContain(phrase);
  });

  it("gives a code it does not know a message of its own, not the test's", async () => {
    const { bed, page } = await openEditor();
    bed.handlers["models.discover"] = () => ({ models: [], code: "weird" });
    await click(button(page.container, "Discover models"));
    await settle();
    expect(alerts(page.container)).toEqual(["Discovery failed."]);
  });

  it("says when the list was cut and when nothing was found", async () => {
    const { bed, page } = await openEditor();
    bed.handlers["models.discover"] = () => ({ models: [{ id: "d-1" }], truncated: true });
    await click(button(page.container, "Discover models"));
    await settle();
    expect(text(page.container)).toContain("The list is cut");
    bed.handlers["models.discover"] = () => ({ models: [] });
    await click(button(page.container, "Discover models"));
    await settle();
    expect(text(page.container)).toContain("The provider lists no models.");
  });
});

describe("test", () => {
  it("shows a pass with its latency, and asks for no password", async () => {
    const { bed, page } = await openEditor();
    bed.handlers["models.test"] = () => ({ ok: true, latencyMs: 123 });
    await click(button(page.container, "Test model"));
    await settle();
    expect(bed.called("models.test")[0]?.params).toEqual({ provider: "mine", modelId: "m-1" });
    expect(prompt.asked).toBe(0);
    expect(text(page.container)).toContain("The model answered in 123 ms.");
  });

  it("shows a failure as the fixed code text only", async () => {
    const { bed, page } = await openEditor();
    bed.handlers["models.test"] = () => ({ ok: false, latencyMs: 40, code: "http_4xx" });
    await click(button(page.container, "Test model"));
    await settle();
    expect(alerts(page.container).join(" ")).toContain("refused the request");
    expect(text(page.container)).not.toContain("answered in");
  });
});

describe("fr", () => {
  it("shows the editor in French", async () => {
    setLocale("fr");
    const { page } = await openEditor_fr();
    expect(text(page.container)).toContain("Les secrets s'affichent");
  });
});

async function openEditor_fr() {
  const bed = newBed(MINE_WITH_MODELS);
  bed.handlers["models.config.get"] = () => ({
    path: "/a/models.json",
    text: MASKED,
    issues: [],
    revision: REVISION,
  });
  const page = await show();
  await settle();
  await click(providerButton(page.container, "mine"));
  await click(button(page.container, "Modifier models.json"));
  await settle();
  return { bed, page };
}
