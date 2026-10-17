// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, click, mount, settle, text } from "../../../testing/dom.ts";
import { current, newBed, stepUp } from "../models-bed.tsx";
import { DiscoverImport } from "./DiscoverImport.tsx";
import { emptyModel, type ModelDraft } from "./provider-form.vm.ts";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const found = (count: number) => ({
  models: Array.from({ length: count }, (_, i) => ({ id: `model-${i}` })),
});
const row = (container: ParentNode, id: string) =>
  container.querySelector(`[data-discovered="${id}"] [role="checkbox"]`) as HTMLButtonElement;

async function open(count: number, models: readonly ModelDraft[] = []) {
  const bed = newBed();
  bed.handlers["models.discover"] = () => found(count);
  const imported: ModelDraft[][] = [];
  const page = await mount(
    <DiscoverImport
      provider="mine"
      models={models}
      stepUp={stepUp}
      onImport={(added) => imported.push([...added])}
    />,
  );
  await click(button(page.container, "Discover models"));
  await settle();
  return { bed, page, imported };
}

describe("discover import: the cap of 500 (MPR20)", () => {
  it("600 discovered models import at most 500, and the form says why", async () => {
    const { page, imported } = await open(600);
    expect(text(page.container)).toContain("Only 500 of these models fit");
    await click(button(page.container, "Tick all that fit"));
    await click(button(page.container, "Add 500 to the form"));
    expect(imported).toHaveLength(1);
    expect(imported[0]).toHaveLength(500);
    expect(imported[0]?.[499]?.id).toBe("model-499");
    expect(imported[0]?.map((one) => one.id)).not.toContain("model-500");
  });

  it("the rows past the cap are shown disabled while the ticked ones stay enabled", async () => {
    const { page } = await open(600);
    await click(button(page.container, "Tick all that fit"));
    for (let i = 0; i < 5; i += 1) await click(button(page.container, "Show 100 more"));
    expect(row(page.container, "model-10").disabled).toBe(false);
    expect(row(page.container, "model-10").getAttribute("aria-checked")).toBe("true");
    expect(row(page.container, "model-550").disabled).toBe(true);
    expect(row(page.container, "model-550").getAttribute("aria-checked")).toBe("false");
  }, 20_000);

  it("rows the form already holds count against the room", async () => {
    const held = Array.from({ length: 495 }, (_, i) => ({ ...emptyModel(), id: `held-${i}` }));
    const { page, imported } = await open(20, held);
    expect(text(page.container)).toContain("Only 5 of these models fit");
    await click(button(page.container, "Tick all that fit"));
    expect(row(page.container, "model-9").disabled).toBe(true);
    await click(button(page.container, "Add 5 to the form"));
    expect(imported[0]).toHaveLength(5);
  });

  it("a discovery fills rows only: nothing else is called", async () => {
    const { bed, page } = await open(3);
    await click(button(page.container, "Tick all that fit"));
    await click(button(page.container, "Add 3 to the form"));
    expect(bed.calls.map((call) => call.method)).toEqual(["models.discover"]);
    expect(text(page.container)).toContain("Nothing is saved until you press Save");
  });
});
