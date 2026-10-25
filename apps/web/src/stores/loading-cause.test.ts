// @vitest-environment happy-dom
import { act, createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { useLaunchStore } from "./launch-store.ts";
import { boxCause, usePiCause } from "./loading-cause.ts";

function Probe() {
  return createElement("p", null, JSON.stringify(usePiCause() ?? null));
}
const setHelpers = (active: number, waiting: number) =>
  act(() => {
    useLaunchStore.getState().apply({ kind: "helpers", helpers: { active, max: 4, waiting } });
  });

describe("loading causes", () => {
  beforeEach(() => {
    useLaunchStore.getState().reset();
  });

  it('Pi reads give "Pi is reading 3 things at once" and "2 reads waiting"', async () => {
    const page = await mount(createElement(Probe));
    expect(page.container.textContent).toBe("null");
    await setHelpers(1, 0);
    expect(page.container.textContent).toBe("null");
    await setHelpers(3, 0);
    expect(JSON.parse(page.container.textContent)).toEqual({
      key: "loading.cause.pi",
      vars: { active: 3 },
    });
    await setHelpers(4, 2);
    expect(JSON.parse(page.container.textContent)).toEqual({
      key: "loading.cause.piWaiting",
      vars: { waiting: 2 },
    });
    await page.unmount();
  });

  it("a box that answers slowly has its own key", () => {
    expect(boxCause.key).toBe("loading.cause.box");
  });
});
