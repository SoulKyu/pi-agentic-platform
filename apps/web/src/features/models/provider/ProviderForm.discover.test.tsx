// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../../runtime/index.ts";
import { alerts, button, click, field, settle, text } from "../../../testing/dom.ts";
import { current, editableMine, formBed, MINE, pick, CUSTOM, showForm } from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function editing(discover: () => unknown) {
  const bed = formBed(() => editableMine({ provider: { ...MINE, models: [] } }));
  bed.handlers["models.discover"] = discover;
  return bed;
}
const row = (container: ParentNode, id: string) =>
  container.querySelector(`[data-discovered="${id}"] [role="checkbox"]`) as HTMLButtonElement;
const modelIds = (container: ParentNode) =>
  [...container.querySelectorAll("[data-model-row] input")]
    .filter((one) => (one as HTMLInputElement).labels?.[0]?.textContent === "Model id")
    .map((one) => (one as HTMLInputElement).value);

describe("discover import", () => {
  it("is disabled before the first save and says why", async () => {
    formBed();
    const { page } = await showForm();
    await settle();
    await pick(page.container, CUSTOM);
    expect(button(page.container, "Discover models").disabled).toBe(true);
    expect(text(page.container)).toContain("Save the provider first");
  });

  it("asks the saved provider through the step-up, lists the result and fills only the draft", async () => {
    const bed = editing(() => ({
      models: [{ id: "alpha", contextWindow: 32000, reasoning: true }, { id: "beta" }],
    }));
    const { page, spies } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, "Discover models"));
    await settle();
    expect(bed.called("models.discover")[0]?.params).toEqual({ provider: "mine" });
    expect(text(page.container)).toContain("alpha");
    await click(row(page.container, "alpha"));
    await click(button(page.container, "Add 1 to the form"));
    expect(modelIds(page.container)).toEqual(["alpha"]);
    expect(field(page.container, "Context window").value).toBe("32000");
    expect(bed.called("models.provider.save")).toHaveLength(0);
    expect(spies.saved).toEqual([]);
    expect(text(page.container)).toContain("Nothing is saved until you press Save");
  });

  it("a model already in the form is shown as listed and is not added twice", async () => {
    const bed = formBed(() => editableMine());
    bed.handlers["models.discover"] = () => ({ models: [{ id: "m1" }, { id: "m2" }] });
    const { page } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, "Discover models"));
    await settle();
    expect(row(page.container, "m1").disabled).toBe(true);
    expect(text(page.container)).toContain("Already in the form");
    await click(button(page.container, "Tick all that fit"));
    await click(button(page.container, "Add 1 to the form"));
    expect(modelIds(page.container)).toEqual(["m1", "m2"]);
  });

  it("a failed request shows the code text, an unknown_method asks to reload", async () => {
    editing(() => ({ models: [], code: "http_4xx" }));
    const { page } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, "Discover models"));
    await settle();
    expect(alerts(page.container).length).toBe(1);
    editing(() => {
      throw new RpcError("unknown_method");
    });
    const second = await showForm({ id: "mine" });
    await settle();
    await click(button(second.page.container, "Discover models"));
    await settle();
    expect(alerts(second.page.container)).toContain(
      "This version of the page does not match the server. Reload it.",
    );
  });

  it("strips hidden characters from discovered ids and lists a repeated id once", async () => {
    editing(() => ({ models: [{ id: "a\u200bb" }, { id: "ab" }, { id: "c" }] }));
    const { page } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, "Discover models"));
    await settle();
    expect(page.container.querySelectorAll("[data-discovered]")).toHaveLength(2);
    await click(button(page.container, "Tick all that fit"));
    await click(button(page.container, "Add 2 to the form"));
    expect(modelIds(page.container)).toEqual(["ab", "c"]);
  });
});
