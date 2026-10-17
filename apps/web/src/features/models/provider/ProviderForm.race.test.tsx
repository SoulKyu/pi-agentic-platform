// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, click, hasButton, settle, text } from "../../../testing/dom.ts";
import type { StepUpRunner } from "../step-up.ts";
import {
  CUSTOM,
  current,
  editableMine,
  formBed,
  formElement,
  newSpies,
  pick,
  validCustom,
} from "./provider-models-bed.tsx";
import { mount } from "../../../testing/dom.ts";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/** A step-up that waits for the test before it runs the call. */
function gated() {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const stepUp: StepUpRunner = async (run) => {
    await gate;
    return run("gated-command");
  };
  return { stepUp, open };
}

describe("a late save answer never writes into another target", () => {
  it("create saved after the owner switched to another provider: no reload of the old id, no key offer", async () => {
    const bed = formBed();
    const { stepUp, open } = gated();
    const spies = newSpies();
    const page = await mount(formElement({}, { stepUp }, spies));
    await settle();
    await pick(page.container, CUSTOM);
    await validCustom(page.container);
    await click(button(page.container, "Save"));
    await page.rerender(formElement({ id: "b" }, { stepUp }, spies));
    await settle();
    open();
    await settle();
    expect(bed.called("models.provider.save")).toHaveLength(1);
    expect(bed.called("models.provider.get").map((call) => call.params)).toEqual([{}, { id: "b" }]);
    expect(text(page.container)).not.toContain("Provider saved. Add the key.");
    expect(spies.finished).toEqual([]);
    expect(spies.saved).toEqual([{ id: "mine", stored: true }]);
  });

  it("Remove is disabled while a save runs", async () => {
    formBed(() => editableMine());
    const { stepUp } = gated();
    const page = await mount(formElement({ id: "mine" }, { stepUp }));
    await settle();
    expect(button(page.container, "Remove this provider").disabled).toBe(false);
    await click(button(page.container, "Save"));
    expect(button(page.container, "Remove this provider").disabled).toBe(true);
    expect(hasButton(page.container, "Saving…")).toBe(true);
  });
});
