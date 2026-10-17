// @vitest-environment happy-dom
import type { ProviderView } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { RpcError } from "../../../runtime/index.ts";
import { alerts, button, click, settle, text } from "../../../testing/dom.ts";
import { availabilityBed, BASE, current, showAvailability } from "./availability-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

const opened = async (over = {}) => {
  const made = availabilityBed(over);
  const page = await showAvailability();
  await settle();
  return { ...made, page };
};

/** A connected provider with `count` models named `<id>-<n>`. */
const provider = (id: string, count: number): ProviderView => ({
  ...(BASE[0] as ProviderView),
  id,
  name: id.toUpperCase(),
  models: Array.from({ length: count }, (_, at) => ({
    provider: id,
    id: `${id}-${at}`,
    name: `${id}-${at} name`,
    reasoning: false,
    enabled: true,
  })),
});
const stale = () => new TypeError("Failed to fetch dynamically imported module: /assets/x.js");

describe("the preview count line (carry of task 14)", () => {
  it("is a live region, so a screen reader hears the new count after a switch", async () => {
    const { page } = await opened();
    const live = page.container.querySelector("[data-preview] [role='status']");
    expect(live?.textContent).toContain("2 models");
  });

  it("uses the singular for one model, in English and in French", async () => {
    const { page } = await opened({ providers: [provider("solo", 1)], selected: null });
    expect(text(page.container.querySelector("[data-preview]") as HTMLElement)).toContain("1 model ·");
    await page.unmount();
    setLocale("fr");
    const french = await opened({ providers: [provider("solo", 1)], selected: null });
    expect(text(french.page.container.querySelector("[data-preview]") as HTMLElement)).toContain(
      "1 modèle ·",
    );
  });
});

describe("plural forms", () => {
  it("names one entry, not '1 entries', in the question that deletes the selection", async () => {
    const { page } = await opened({ selected: new Set(["openai/gpt-a"]) });
    await click(button(page.container, "All the models of the connected providers"));
    expect(text(page.container)).toContain("(1 entry)");
    expect(text(page.container)).not.toContain("1 entries");
  });

  it("says '1 entrée' in French", async () => {
    setLocale("fr");
    const { page } = await opened({ selected: new Set(["openai/gpt-a"]) });
    await click(button(page.container, "Tous les modèles des fournisseurs connectés"));
    expect(text(page.container)).toContain("(1 entrée)");
  });

  it("says '1 model' on a row whose preview is not ready, and '1 modèle' in French", async () => {
    const { bed } = availabilityBed();
    bed.handlers["models.available"] = () => {
      throw new RpcError("timeout");
    };
    const page = await showAvailability();
    await settle();
    const row = page.container.querySelector('[data-provider-row="mine"]') as HTMLElement;
    expect(text(row)).toContain("1 model");
    expect(text(row)).not.toContain("1 models");
    await page.unmount();
    setLocale("fr");
    const french = availabilityBed();
    french.bed.handlers["models.available"] = () => {
      throw new RpcError("timeout");
    };
    const again = await showAvailability();
    await settle();
    expect(text(again.container.querySelector('[data-provider-row="mine"]') as HTMLElement)).toContain(
      "1 modèle",
    );
  });
});

describe("the confirmation and the hints", () => {
  it("moves the focus to the confirmation group, so a keyboard user lands on the question", async () => {
    const { page } = await opened();
    await click(button(page.container, "All the models of the connected providers"));
    const group = page.container.querySelector("[role='group']") as HTMLElement;
    expect(group).not.toBeNull();
    expect(document.activeElement).toBe(group);
  });

  it("does not tell a read-only project to choose My selection", async () => {
    const { page } = await opened({ scope: "project", selected: null });
    expect(text(page.container)).not.toContain("Choose My selection");
    expect(text(page.container)).toContain("/work/.pi/settings.json");
  });

  it("still tells a writable scope with no list to choose My selection", async () => {
    const { page } = await opened({ selected: null });
    expect(text(page.container)).toContain("Choose My selection");
  });
});

describe("two preview reads per write (deliberate, docs/agents/models.md)", () => {
  it("reads the list again after a write that failed, and shows the failure", async () => {
    const { page, bed } = await opened();
    bed.handlers["models.setEnabled"] = () => {
      throw new RpcError("conflict");
    };
    await click(button(page.container, "Show the models of OpenAI"));
    const before = bed.called("models.available").length;
    const toggle = [...page.container.querySelectorAll("[data-model='gpt-a'] [role='switch']")][0];
    await click(toggle as HTMLElement);
    await settle();
    expect(bed.called("models.available").length).toBeGreaterThan(before);
    expect(alerts(page.container).join(" ")).toContain("At least one model must stay on");
  });
});

describe("a stale page (an old shell, a chunk that is gone)", () => {
  it("asks for a reload when the preview read dies on a stale chunk", async () => {
    const { bed } = availabilityBed();
    bed.handlers["models.available"] = () => {
      throw stale();
    };
    const page = await showAvailability();
    await settle();
    expect(alerts(page.container).join(" ")).toContain("Reload the page");
  });

  it("asks for a reload when the extension read dies on a stale chunk", async () => {
    const { bed } = availabilityBed();
    bed.handlers["models.extensions"] = () => {
      throw stale();
    };
    const page = await showAvailability();
    await settle();
    await click(button(page.container, "Read providers added by extensions"));
    await settle();
    expect(alerts(page.container).join(" ")).toContain("Reload the page");
  });
});

describe("big lists", () => {
  it("draws 100 model switches of a provider, then 100 more on request", async () => {
    const { page } = await opened({ providers: [provider("big", 230)], selected: null });
    await click(button(page.container, "Show the models of BIG"));
    const rows = () => page.container.querySelectorAll("[data-provider-row='big'] [data-model]").length;
    expect(rows()).toBe(100);
    await click(button(page.container, "Show 130 more"));
    expect(rows()).toBe(200);
  });

  it("lists 20 names of a preview group and counts the rest", async () => {
    const { page } = await opened({ providers: [provider("big", 230)], selected: null });
    const preview = page.container.querySelector("[data-preview]") as HTMLElement;
    expect(preview.querySelectorAll("[data-preview-model]")).toHaveLength(20);
    expect(text(preview)).toContain("and 210 more");
  });

  it("draws 5 provider groups of the preview, then all of them on request", async () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((id) => provider(`p${id}`, 1));
    const { page } = await opened({ providers: many, selected: null });
    const groups = () => page.container.querySelectorAll("[data-preview-group]").length;
    expect(groups()).toBe(5);
    await click(button(page.container, "Show 2 more providers"));
    expect(groups()).toBe(7);
    await click(button(page.container, "Show fewer providers"));
    expect(groups()).toBe(5);
  });
});

describe("keys that cannot collide (raw ids come from models.json)", () => {
  it("renders two models and two providers with the same id without a React key warning", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const one = provider("twin", 1);
    const twin = { ...one, models: [...one.models, ...one.models] };
    const { bed } = availabilityBed({ providers: [twin, one], selected: null });
    bed.handlers["models.available"] = () => ({
      models: [
        { provider: "twin", id: "twin-0", name: "a", reasoning: false },
        { provider: "twin", id: "twin-0", name: "a", reasoning: false },
      ],
      providers: [{ id: "twin", name: "Twin" }],
      origin: "signed-in",
      truncated: false,
    });
    const page = await showAvailability();
    await settle();
    for (const trigger of [...page.container.querySelectorAll("button")].filter((one) =>
      (one.textContent ?? "").startsWith("Show the models of"),
    ))
      await click(trigger);
    await settle();
    expect(page.container.querySelectorAll("[data-provider-row]")).toHaveLength(2);
    const warnings = error.mock.calls.map((call) => call.map(String).join(" "));
    expect(warnings.filter((line) => line.includes("same key"))).toEqual([]);
  });
});

describe("overrides when the provider list is cut short", () => {
  it("says an override may be unmarked when the overview is truncated", async () => {
    const { bed, page } = await opened({ truncated: true });
    bed.handlers["models.extensions"] = () => ({ providers: [], truncated: false, failed: false });
    await click(button(page.container, "Read providers added by extensions"));
    await settle();
    expect(text(page.container.querySelector("[data-extensions]") as HTMLElement)).toContain(
      "may not be marked",
    );
  });

  it("says nothing of the kind when the overview is whole", async () => {
    const { bed, page } = await opened();
    bed.handlers["models.extensions"] = () => ({ providers: [], truncated: false, failed: false });
    await click(button(page.container, "Read providers added by extensions"));
    await settle();
    expect(text(page.container.querySelector("[data-extensions]") as HTMLElement)).not.toContain(
      "may not be marked",
    );
  });
});
