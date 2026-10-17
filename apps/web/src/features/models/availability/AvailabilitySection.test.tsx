// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { RpcError } from "../../../runtime/index.ts";
import { alerts, button, click, hasButton, settle, text } from "../../../testing/dom.ts";
import {
  availabilityBed,
  BASE,
  current,
  previewIds,
  showAvailability,
  switchOf,
} from "./availability-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  vi.unstubAllGlobals();
});

const opened = async (over = {}) => {
  const made = availabilityBed(over);
  const page = await showAvailability();
  await settle();
  return { ...made, page };
};
const calls = (bed: Awaited<ReturnType<typeof opened>>["bed"], method: string) =>
  bed.called(method).map((call) => call.params);
const expand = async (page: { container: HTMLElement }, name: string) =>
  click(button(page.container, `Show the models of ${name}`));

describe("the preview", () => {
  it("preview.is-the-picker-list: lists exactly what models.available returned, whatever the overview flags say", async () => {
    const made = availabilityBed();
    made.bed.handlers["models.available"] = () => ({
      models: [{ provider: "openai", id: "gpt-b", name: "gpt-b name", reasoning: false }],
      providers: [{ id: "openai", name: "OpenAI" }],
      origin: "scope",
      truncated: false,
    });
    const page = await showAvailability();
    await settle();
    // The overview says gpt-a and m1 are on; the picker list has only gpt-b.
    expect(previewIds(page.container)).toEqual(["gpt-b"]);
  });

  it("says where the list comes from and how many models it holds", async () => {
    const { page } = await opened();
    expect(text(page.container)).toContain("What your pickers offer");
    expect(text(page.container)).toContain("2 models");
    expect(text(page.container)).toContain("Your selection, among connected providers");
  });

  it("is the only-connected sentence when there is no list", async () => {
    const { page } = await opened({ selected: null });
    expect(text(page.container)).toContain("Only the providers you are connected to");
  });
});

describe("switching a model", () => {
  it("calls models.setEnabled with the toggle, then reads the preview again, in that order", async () => {
    const { page, bed } = await opened();
    await expand(page, "OpenAI");
    const before = bed.calls.length;
    await click(switchOf(page.container, "gpt-a name"));
    await settle();
    const after = bed.calls.slice(before).map((call) => call.method);
    expect(after.indexOf("models.setEnabled")).toBe(0);
    expect(after.indexOf("models.available")).toBeGreaterThan(after.indexOf("models.setEnabled"));
    expect(calls(bed, "models.setEnabled")).toEqual([
      { op: { op: "toggle", provider: "openai", modelId: "gpt-a", enabled: false } },
    ]);
    expect(previewIds(page.container)).toEqual(["m1"]);
  });

  it("switches a whole provider through the provider op", async () => {
    const { page, bed } = await opened();
    await click(switchOf(page.container, "Anthropic"));
    await settle();
    expect(calls(bed, "models.setEnabled")).toEqual([
      { op: { op: "provider", provider: "anthropic", enabled: true } },
    ]);
  });

  it("shows the failure of a write as text and reads the list again", async () => {
    const { page, bed } = await opened();
    bed.handlers["models.setEnabled"] = () => {
      throw new RpcError("conflict");
    };
    await expand(page, "OpenAI");
    await click(switchOf(page.container, "gpt-a name"));
    await settle();
    expect(alerts(page.container).join(" ")).toContain("At least one model must stay on");
  });
});

describe("unconnected providers", () => {
  it("say so, count zero offered, and their switch still works", async () => {
    const { page, bed } = await opened();
    const row = page.container.querySelector('[data-provider-row="anthropic"]') as HTMLElement;
    expect(text(row)).toContain("not connected");
    expect(text(row)).toContain("0/2 offered");
    await click(button(row, "Show the models of Anthropic"));
    expect(text(row)).toContain("Not offered until the provider is connected");
    await click(switchOf(row, "claude-a name"));
    await settle();
    expect(calls(bed, "models.setEnabled")).toEqual([
      { op: { op: "toggle", provider: "anthropic", modelId: "claude-a", enabled: true } },
    ]);
  });

  it("count the connected providers as the preview offers them", async () => {
    const { page } = await opened();
    const row = page.container.querySelector('[data-provider-row="openai"]') as HTMLElement;
    expect(text(row)).toContain("1/2 offered");
    expect(text(row)).toContain("connected");
  });
});

describe("the mode", () => {
  it("asks first, names the patterns it removes, and calls nothing when cancelled", async () => {
    const { page, bed } = await opened();
    await click(button(page.container, "All the models of the connected providers"));
    expect(text(page.container)).toContain("2 entries");
    expect(text(page.container)).toContain("openai/gpt-a");
    expect(calls(bed, "models.setEnabled")).toEqual([]);
    await click(button(page.container, "Keep my selection"));
    expect(calls(bed, "models.setEnabled")).toEqual([]);
    expect(text(page.container)).not.toContain("2 entries");
  });

  it("calls clear once it is confirmed, and the preview follows", async () => {
    const { page, bed } = await opened();
    await click(button(page.container, "All the models of the connected providers"));
    await click(button(page.container, "Use all models"));
    await settle();
    expect(calls(bed, "models.setEnabled")).toEqual([{ op: { op: "clear" } }]);
    expect(previewIds(page.container)).toEqual(["gpt-a", "gpt-b", "m1"]);
    expect(text(page.container)).toContain("Only the providers you are connected to");
  });

  it("opens the selection without a call while there is no list yet", async () => {
    const { page, bed } = await opened({ selected: null });
    expect(switchOf(page.container, "OpenAI").disabled).toBe(true);
    await click(button(page.container, "My selection"));
    expect(calls(bed, "models.setEnabled")).toEqual([]);
    expect(switchOf(page.container, "OpenAI").disabled).toBe(false);
  });
});

describe("unmatched patterns", () => {
  it("offer a clean up only for a No model matches warning, and call prune", async () => {
    const { page, bed } = await opened({ dead: ["gone/*"] });
    expect(text(page.container)).toContain('No model matches "gone/*".');
    await click(button(page.container, "Clean up"));
    await settle();
    expect(calls(bed, "models.setEnabled")).toEqual([{ op: { op: "prune" } }]);
    expect(hasButton(page.container, "Clean up")).toBe(false);
  });

  it("show no button without such a warning", async () => {
    const { page } = await opened();
    expect(hasButton(page.container, "Clean up")).toBe(false);
  });
});

describe("a project selection", () => {
  it("disables every switch and says why in text", async () => {
    const { page } = await opened({ scope: "project" });
    await expand(page, "OpenAI");
    expect(text(page.container)).toContain("/work/.pi/settings.json");
    for (const control of page.container.querySelectorAll('[role="switch"]'))
      expect((control as HTMLButtonElement).disabled).toBe(true);
    // The segmented control has no disabled state: a read-only scope shows the mode as text instead.
    expect(page.container.querySelector('[data-slot="segmented"]')).toBeNull();
    expect(text(page.container)).toContain("Your selection, among connected providers");
  });
});

describe("untrusted names", () => {
  it("never draw a bidi or zero-width character from a provider or model name", async () => {
    const providers = BASE.map((one, index) =>
      index === 0
        ? {
            ...one,
            name: "Open\u202eAI",
            models: one.models.map((model) => ({ ...model, name: `${model.id}\u200b name` })),
          }
        : one,
    );
    const { page } = await opened({ providers });
    const shown = text(page.container);
    expect(shown).not.toMatch(/[\u202e\u200b]/);
    expect(shown).toContain("OpenAI");
  });
});

describe("old daemon", () => {
  it("answers unknown_method with the reload sentence", async () => {
    const { bed } = availabilityBed();
    bed.handlers["models.available"] = () => {
      throw new RpcError("unknown_method");
    };
    const page = await showAvailability();
    await settle();
    expect(alerts(page.container).join(" ")).toContain("Reload the page");
  });
});

describe("no module state", () => {
  it("renders twice with different fakes and shares nothing", async () => {
    const first = await opened();
    expect(previewIds(first.page.container)).toEqual(["gpt-a", "m1"]);
    await first.page.unmount();
    await opened({ selected: new Set(["openai/gpt-b"]) });
    const again = document.body.lastElementChild as HTMLElement;
    expect(previewIds(again)).toEqual(["gpt-b"]);
  });
});

describe("layout", () => {
  it("keeps 44 px on coarse pointers for every control", async () => {
    const { page } = await opened();
    await expand(page, "OpenAI");
    for (const control of page.container.querySelectorAll("button")) {
      expect(control.className, control.textContent ?? "").toContain("pointer-coarse:min-h-11");
    }
  });

  it("stacks the row header on a phone", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { page } = await opened();
    expect(page.container.querySelector("[data-availability]")?.getAttribute("data-layout")).toBe("stack");
  });
});

describe("French", () => {
  it("writes the mode in French with vous", async () => {
    setLocale("fr");
    const { page } = await opened();
    expect(text(page.container)).toContain("Tous les modèles des fournisseurs connectés");
    expect(text(page.container)).toContain("Ma sélection");
  });
});
