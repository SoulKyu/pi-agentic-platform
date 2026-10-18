// @vitest-environment happy-dom
import type { ExtensionProviders as Answer } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { button, click, hasButton, settle, text } from "../../../testing/dom.ts";
import { forgetExtensions } from "../extension-read.ts";
import {
  availabilityBed,
  current,
  showAvailability,
  switchOf,
  type World,
} from "./availability-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  forgetExtensions();
});

const READ = "Read providers added by extensions";
// A raw id with a hidden character: a write must carry it as Pi has it, the screen shows it cleaned.
const RAW = "claude-opus-4\u200b";

/** The daemon's answer as the world's selection makes it: the bridge's models are enabled when the world selects them. */
function bridgeAnswer(world: World): Answer {
  const on = (id: string) => world.selected === null || world.selected.has(`claude-bridge/${id}`);
  return {
    providers: [
      {
        id: "claude-bridge",
        name: "Claude bridge",
        models: [RAW, "claude-haiku-4"].map((id) => ({
          provider: "claude-bridge",
          id,
          name: id === RAW ? "Opus via bridge" : "Haiku via bridge",
          reasoning: true,
          enabled: on(id),
          offered: on(id),
        })),
        modelsTruncated: false,
      },
    ],
    truncated: false,
    failed: false,
  };
}

async function opened(over: Partial<World> = {}) {
  const { bed, world } = availabilityBed(over);
  bed.handlers["models.extensions"] = () => bridgeAnswer(world);
  // The fake daemon's world knows the overview's providers only: the bridge's provider op is applied here.
  const write = bed.handlers["models.setEnabled"] as (params: unknown) => unknown;
  bed.handlers["models.setEnabled"] = (params) => {
    const { op } = params as { op: { op: string; provider?: string; enabled?: boolean } };
    if (op.op !== "provider" || op.provider !== "claude-bridge") return write(params);
    for (const id of [RAW, "claude-haiku-4"])
      if (op.enabled) world.selected?.add(`claude-bridge/${id}`);
      else world.selected?.delete(`claude-bridge/${id}`);
    return { patterns: world.selected === null ? null : [...world.selected] };
  };
  const page = await showAvailability();
  await settle();
  await click(button(page.container, READ));
  await settle();
  return { bed, world, page };
}
const setEnabledCalls = (bed: { called(method: string): Array<{ params: unknown }> }) =>
  bed.called("models.setEnabled").map((call) => call.params);

describe("My selection and an extension's models (Settings)", () => {
  it("ext.switch-model: a model's switch writes the exact provider/modelId, then the extensions are read again", async () => {
    const { bed, page } = await opened();
    const box = page.container.querySelector("[data-extensions]") as HTMLElement;
    expect(text(box)).not.toMatch(/\u200b/);
    expect(switchOf(box, "Opus via bridge").getAttribute("aria-checked")).toBe("false");
    await click(switchOf(box, "Opus via bridge"));
    await settle();
    expect(setEnabledCalls(bed)).toEqual([
      { op: { op: "toggle", provider: "claude-bridge", modelId: RAW, enabled: true } },
    ]);
    // The answer read in this tab follows the selection: it is read again after the write.
    expect(bed.called("models.extensions")).toHaveLength(2);
    expect(switchOf(box, "Opus via bridge").getAttribute("aria-checked")).toBe("true");
    expect(text(box)).toContain("1 of 2");
  });

  it("ext.switch-provider: the provider's switch writes its provider op, as for any provider", async () => {
    const { bed, page } = await opened();
    const box = page.container.querySelector("[data-extensions]") as HTMLElement;
    await click(switchOf(box, "Claude bridge"));
    await settle();
    expect(setEnabledCalls(bed)).toEqual([
      { op: { op: "provider", provider: "claude-bridge", enabled: true } },
    ]);
    expect(switchOf(box, "Claude bridge").getAttribute("aria-checked")).toBe("true");
  });

  it("ext.switch-all-mode: with every model on there is no list to edit: the switches show on and do not move", async () => {
    const { page } = await opened({ selected: null });
    const box = page.container.querySelector("[data-extensions]") as HTMLElement;
    for (const label of ["Claude bridge", "Opus via bridge", "Haiku via bridge"]) {
      expect(switchOf(box, label).getAttribute("aria-checked")).toBe("true");
      expect(switchOf(box, label).disabled).toBe(true);
    }
  });

  it("ext.switch-project: a project's selection makes them read-only too", async () => {
    const { page } = await opened({ scope: "project" });
    const box = page.container.querySelector("[data-extensions]") as HTMLElement;
    expect(switchOf(box, "Opus via bridge").disabled).toBe(true);
  });

  it("ext.no-read-no-call: with nothing read in this tab, a write asks models.extensions nothing", async () => {
    const { bed } = availabilityBed();
    bed.handlers["models.extensions"] = () => {
      throw new Error("never asked");
    };
    const page = await showAvailability();
    await settle();
    await click(button(page.container, "Show the models of OpenAI"));
    await click(switchOf(page.container, "gpt-b name"));
    await settle();
    expect(setEnabledCalls(bed)).toHaveLength(1);
    expect(bed.called("models.extensions")).toEqual([]);
    expect(hasButton(page.container, READ)).toBe(true);
  });
});

describe("Clean up and the entries it cannot judge (Settings)", () => {
  it("cleanup.marks: an entry whose provider the view does not know is marked kept; Clean up stays for the others", async () => {
    const { page } = await opened({ dead: ["openai/gone", "claude-bridge/old-one", "elsewhere/x"] });
    const rows = [...page.container.querySelectorAll<HTMLElement>("[data-unmatched]")];
    expect(rows.map((row) => row.dataset.unmatched)).toEqual(["removed", "extension", "unjudged"]);
    expect(text(rows[1] as HTMLElement)).toContain("An extension adds this provider");
    expect(text(rows[2] as HTMLElement)).toContain("Kept by Clean up");
    expect(hasButton(page.container, "Clean up")).toBe(true);
  });

  it("cleanup.nothing-to-remove: when Clean up would keep every entry it is not offered", async () => {
    const { bed } = availabilityBed({ dead: ["claude-bridge/x"] });
    const page = await showAvailability();
    await settle();
    expect(text(page.container)).toContain('No model matches "claude-bridge/x".');
    expect(text(page.container)).toContain("Kept by Clean up");
    expect(hasButton(page.container, "Clean up")).toBe(false);
    expect(setEnabledCalls(bed)).toEqual([]);
  });

  it("is in French with vous", async () => {
    setLocale("fr");
    const { bed } = availabilityBed({ dead: ["claude-bridge/x"] });
    bed.handlers["models.extensions"] = () => ({ providers: [], truncated: false, failed: false });
    const page = await showAvailability();
    await settle();
    expect(text(page.container)).toContain("Gardée par Nettoyer");
  });
});
