// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../../testing/dom.ts";
import { LIFECYCLES, type Lifecycle } from "./agent-lifecycle.ts";
import { ComposerLifecycle } from "./LifecycleChip.tsx";

const shown = async (lifecycle: Lifecycle | null) => {
  const page = await mount(<ComposerLifecycle lifecycle={lifecycle} />);
  return (
    page.container
      .querySelector("[data-composer-lifecycle] [data-lifecycle]")
      ?.getAttribute("data-lifecycle") ?? null
  );
};

describe("the chip above the composer", () => {
  it("appears only for a state that asks for an action or explains a delay", async () => {
    const found = await Promise.all(LIFECYCLES.map(shown));
    expect(Object.fromEntries(LIFECYCLES.map((state, i) => [state, found[i]]))).toEqual({
      working: null,
      needs_input: "needs_input",
      waking: "waking",
      paused: "paused",
      parked: null,
      failed: null,
      quarantined: null,
    });
  });

  it("never appears for a ready agent", async () => {
    expect(await shown(null)).toBeNull();
  });
});
