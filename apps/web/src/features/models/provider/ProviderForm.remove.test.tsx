// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../../runtime/index.ts";
import { alerts, button, click, hasButton, settle, text } from "../../../testing/dom.ts";
import { current, editableMine, formBed, NEXT_REVISION, REVISION, showForm } from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const REMOVE = "Remove this provider";
const CONFIRM = "Yes, remove it";
const keyBox = (container: ParentNode) =>
  [...container.querySelectorAll('[data-slot="checkbox"]')]
    .find((one) => one.textContent?.includes("Also remove the stored key"))
    ?.querySelector('[role="checkbox"]') as HTMLButtonElement;

function removable(get: () => unknown = () => editableMine()) {
  const bed = formBed(get);
  bed.handlers["models.provider.remove"] = () => ({ revision: NEXT_REVISION, enabledModelsSynced: true });
  return bed;
}

describe("remove", () => {
  it("asks first, naming the provider, with the key checkbox unticked, and sends nothing before the answer", async () => {
    const bed = removable();
    const { page } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, REMOVE));
    expect(text(page.container)).toContain("Remove Mine from models.json?");
    expect(keyBox(page.container).getAttribute("aria-checked")).toBe("false");
    expect(bed.called("models.provider.remove")).toHaveLength(0);
    await click(button(page.container, "Keep it"));
    expect(hasButton(page.container, CONFIRM)).toBe(false);
    expect(bed.called("models.provider.remove")).toHaveLength(0);
  });

  it("sends the revision the form read, alsoRemoveKey false by default, then reports it removed", async () => {
    const bed = removable();
    const { page, spies } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, REMOVE));
    await click(button(page.container, CONFIRM));
    await settle();
    expect(bed.called("models.provider.remove")[0]?.params).toEqual({
      id: "mine",
      baseRevision: REVISION,
      alsoRemoveKey: false,
    });
    expect(bed.called("models.config.get")).toHaveLength(0);
    expect(spies.removed).toEqual(["mine"]);
  });

  it("alsoRemoveKey is true only when the box is ticked", async () => {
    const bed = removable();
    const { page } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, REMOVE));
    await click(keyBox(page.container));
    await click(button(page.container, CONFIRM));
    await settle();
    expect(
      (bed.called("models.provider.remove")[0]?.params as { alsoRemoveKey: boolean }).alsoRemoveKey,
    ).toBe(true);
  });

  it("works for a provider the form cannot edit", async () => {
    const bed = removable(() => ({ editable: false, reason: "url_unsupported", revision: REVISION }));
    const { page, spies } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, REMOVE));
    await click(button(page.container, CONFIRM));
    await settle();
    expect(bed.called("models.provider.remove")[0]?.params).toMatchObject({
      id: "mine",
      baseRevision: REVISION,
    });
    expect(spies.removed).toEqual(["mine"]);
  });

  it("is not offered for a built-in provider, for a provider gone from the file, or for a new one", async () => {
    for (const reason of ["builtin", "not_in_file"] as const) {
      removable(() => ({ editable: false, reason, revision: REVISION }));
      const { page } = await showForm({ id: "mine" });
      await settle();
      expect(hasButton(page.container, REMOVE), reason).toBe(false);
      await page.unmount();
    }
    removable();
    const created = await showForm();
    await settle();
    expect(hasButton(created.page.container, REMOVE)).toBe(false);
  });

  it("a conflict reloads the revision and asks to confirm again", async () => {
    let removes = 0;
    let reads = 0;
    const bed = formBed(() => editableMine({ revision: ++reads === 1 ? REVISION : "d".repeat(64) }));
    bed.handlers["models.provider.remove"] = () => {
      removes += 1;
      if (removes === 1) throw new RpcError("conflict");
      return { revision: NEXT_REVISION, enabledModelsSynced: true };
    };
    const { page, spies } = await showForm({ id: "mine" });
    await settle();
    await click(button(page.container, REMOVE));
    await click(button(page.container, CONFIRM));
    await settle();
    expect(alerts(page.container)).toContain("The file changed; check, then remove again.");
    expect(spies.removed).toEqual([]);
    await click(button(page.container, CONFIRM));
    await settle();
    expect(
      bed
        .called("models.provider.remove")
        .map((call) => (call.params as { baseRevision: string }).baseRevision),
    ).toEqual([REVISION, "d".repeat(64)]);
    expect(spies.removed).toEqual(["mine"]);
  });

  it("a $.file issue gives the comments sentence; a cancelled step-up sends nothing", async () => {
    const bed = removable();
    bed.handlers["models.provider.remove"] = () => ({ code: "config_invalid", issues: ["$.file"] });
    const first = await showForm({ id: "mine" });
    await settle();
    await click(button(first.page.container, REMOVE));
    await click(button(first.page.container, CONFIRM));
    await settle();
    expect(alerts(first.page.container).join(" ")).toContain("comments or trailing commas");
    await first.page.unmount();
    const other = removable();
    const second = await showForm({ id: "mine" }, { stepUp: async () => null });
    await settle();
    await click(button(second.page.container, REMOVE));
    await click(button(second.page.container, CONFIRM));
    await settle();
    expect(other.called("models.provider.remove")).toHaveLength(0);
    expect(second.spies.removed).toEqual([]);
  });
});
