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
  switchOf,
} from "./models-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const REVISION = "a".repeat(64);
const FILE = '{\n  "providers": {\n    "mine": { "models": [ { "id": "m-1" } ] }\n  }\n}\n';
const LABEL = "Look up prices on models.dev";

beforeEach(() => {
  sessionStorage.clear();
  prompt.answer = true;
  prompt.asked = 0;
});
afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

const overview = overviewOf({
  providers: PROVIDERS.map((one) =>
    one.id === "mine" ? { ...one, models: [model("mine", "m-1", true)] } : one,
  ),
});

function start(setting: { value: unknown; revision: number } | null) {
  const bed = newBed(overview);
  if (setting) bed.handlers["settings.get"] = () => setting;
  bed.handlers["models.config.get"] = () => ({
    path: "/a/models.json",
    text: FILE,
    issues: [],
    revision: REVISION,
  });
  return bed;
}

async function openEditor(page: Awaited<ReturnType<typeof show>>) {
  await click(providerButton(page.container, "mine"));
  await click(button(page.container, "Edit models.json"));
  await settle();
}

describe("the models.dev switch", () => {
  it("is off by default, names models.dev, and no lookup control or request exists", async () => {
    const bed = start(null);
    const page = await show();
    await settle();
    expect(switchOf(page.container, LABEL).getAttribute("aria-checked")).toBe("false");
    expect(text(page.container)).toContain("pap sends nothing to models.dev until you click Look up");
    await openEditor(page);
    expect(hasButton(page.container, "Look up")).toBe(false);
    expect(bed.called("models.pricing")).toEqual([]);
  });

  it("stays off when the stored value is missing, malformed or its read fails", async () => {
    for (const value of [null, { modelsDevPricing: "yes" }, "on"]) {
      const bed = start({ value, revision: 2 });
      const page = await show();
      await settle();
      expect(switchOf(page.container, LABEL).getAttribute("aria-checked")).toBe("false");
      await openEditor(page);
      expect(hasButton(page.container, "Look up")).toBe(false);
      expect(bed.called("models.pricing")).toEqual([]);
      await page.unmount();
    }
    const bed = start(null);
    bed.handlers["settings.get"] = () => {
      throw new RpcError("internal");
    };
    const page = await show();
    await settle();
    await openEditor(page);
    expect(hasButton(page.container, "Look up")).toBe(false);
  });

  it("switching on sends settings.set with the revision it read and shows the control", async () => {
    const bed = start({ value: { modelsDevPricing: false }, revision: 4 });
    bed.handlers["settings.set"] = () => ({ revision: 5 });
    const page = await show();
    await settle();
    await openEditor(page);
    await click(switchOf(page.container, LABEL));
    await settle();
    const [set] = bed.called("settings.set");
    expect(set?.params).toEqual({ key: "models", value: { modelsDevPricing: true }, baseRevision: 4 });
    expect(set?.options?.commandId).toBe("bed-cmd-00000001");
    expect(switchOf(page.container, LABEL).getAttribute("aria-checked")).toBe("true");
    expect(hasButton(page.container, "Look up")).toBe(true);
    expect(bed.called("models.pricing")).toEqual([]);
  });

  it("reads the setting again after a conflict and says so", async () => {
    const bed = start({ value: { modelsDevPricing: false }, revision: 4 });
    bed.handlers["settings.set"] = () => {
      throw new RpcError("conflict");
    };
    const page = await show();
    await settle();
    const reads = bed.called("settings.get").length;
    await click(switchOf(page.container, LABEL));
    await settle();
    expect(bed.called("settings.get").length).toBe(reads + 1);
    expect(text(page.container)).toContain("changed elsewhere");
  });
});

const prices = (page: Awaited<ReturnType<typeof show>>) =>
  page.container.querySelector<HTMLElement>('section[aria-label="Prices"]') as HTMLElement;

describe("the lookup", () => {
  const on = { value: { modelsDevPricing: true }, revision: 3 };

  it("fills the prices into the draft only, never saving", async () => {
    const bed = start(on);
    bed.handlers["models.pricing"] = () => ({
      entries: [{ provider: "openai", id: "m-1", input: 2.5, output: 10, cacheRead: 1.25 }],
    });
    const page = await show();
    await settle();
    await openEditor(page);
    await click(button(page.container, "Look up"));
    await settle();
    expect(bed.called("models.pricing")[0]?.params).toEqual({ modelId: "m-1" });
    expect(text(page.container)).toContain("openai");
    await click(button(page.container, "Use prices from openai"));
    const draft = (field(page.container, "models.json") as HTMLTextAreaElement).value;
    expect(JSON.parse(draft).providers.mine.models[0]).toEqual({
      id: "m-1",
      cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
    });
    expect(bed.called("models.config.save")).toEqual([]);
  });

  it("says so when models.dev knows nothing of the model", async () => {
    const bed = start(on);
    bed.handlers["models.pricing"] = () => ({ entries: [] });
    const page = await show();
    await settle();
    await openEditor(page);
    await click(button(page.container, "Look up"));
    await settle();
    expect(text(page.container)).toContain("models.dev has no prices for this model.");
  });

  it("reads the setting again when the daemon answers forbidden, and the control goes away", async () => {
    const bed = start(on);
    bed.handlers["models.pricing"] = () => {
      bed.handlers["settings.get"] = () => ({ value: { modelsDevPricing: false }, revision: 4 });
      throw new RpcError("forbidden");
    };
    const page = await show();
    await settle();
    await openEditor(page);
    const reads = bed.called("settings.get").length;
    await click(button(page.container, "Look up"));
    await settle();
    expect(bed.called("settings.get").length).toBe(reads + 1);
    expect(hasButton(page.container, "Look up")).toBe(false);
    expect(switchOf(page.container, LABEL).getAttribute("aria-checked")).toBe("false");
  });

  it("shows another failure as its fixed text", async () => {
    const bed = start(on);
    bed.handlers["models.pricing"] = () => {
      throw new RpcError("timeout");
    };
    const page = await show();
    await settle();
    await openEditor(page);
    await click(button(page.container, "Look up"));
    await settle();
    expect(alerts(page.container).length).toBe(1);
  });

  it("never applies a price to another id than the one looked up", async () => {
    const bed = start(on);
    bed.handlers["models.config.get"] = () => ({
      path: "/a/models.json",
      text: '{"providers":{"mine":{"models":[{"id":"m-1"},{"id":"m-2"}]}}}',
      issues: [],
      revision: REVISION,
    });
    bed.handlers["models.pricing"] = () => ({ entries: [{ provider: "openai", id: "m-1", input: 9 }] });
    const page = await show();
    await settle();
    await openEditor(page);
    await click(button(page.container, "Look up"));
    await settle();
    expect(hasButton(page.container, "Use prices from openai")).toBe(true);
    await typeInto(field(prices(page), "Model id") as HTMLInputElement, "m-2");
    expect(hasButton(page.container, "Use prices from openai")).toBe(false);
    const draft = (field(page.container, "models.json") as HTMLTextAreaElement).value;
    expect(draft).not.toContain("cost");
    // The answer for m-1 is applied to m-1 only.
    await typeInto(field(prices(page), "Model id") as HTMLInputElement, "m-1");
    await click(button(page.container, "Look up"));
    await settle();
    await click(button(page.container, "Use prices from openai"));
    const value = JSON.parse((field(page.container, "models.json") as HTMLTextAreaElement).value);
    expect(value.providers.mine.models[0].cost.input).toBe(9);
    expect(value.providers.mine.models[1].cost).toBeUndefined();
  });

  it("asks to add the model to the text first when the draft does not hold it", async () => {
    const bed = start(on);
    bed.handlers["models.config.get"] = () => ({
      path: "/a/models.json",
      text: '{"providers":{}}',
      issues: [],
      revision: REVISION,
    });
    bed.handlers["models.pricing"] = () => ({ entries: [{ provider: "openai", id: "m-1", input: 1 }] });
    const page = await show();
    await settle();
    await openEditor(page);
    await click(button(page.container, "Look up"));
    await settle();
    await click(button(page.container, "Use prices from openai"));
    expect(alerts(page.container).join(" ")).toContain("Add this model to the text first");
  });
});

describe("fr", () => {
  it("names models.dev in French", async () => {
    setLocale("fr");
    start(null);
    const page = await show();
    await settle();
    expect(text(page.container)).toContain("Chercher les prix sur models.dev");
    expect(text(page.container)).toContain("n'envoie rien à models.dev");
  });
});
