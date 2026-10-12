// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { mount } from "../../testing/dom.ts";
import { useViewLabels } from "./use-view-labels.ts";

afterEach(() => useSessionStore.setState({ views: {} }));

describe("useViewLabels", () => {
  it("renders again when a name or folder changes, never for another change of a view", async () => {
    let renders = 0;
    function Probe() {
      renders++;
      return <p>{useViewLabels().a?.name ?? "-"}</p>;
    }
    useSessionStore.setState({ views: { a: { ...EMPTY_VIEW, name: "One", cwd: "/x" } } });
    const page = await mount(<Probe />);
    const first = renders;
    await act(async () =>
      useSessionStore.setState({ views: { a: { ...EMPTY_VIEW, name: "One", cwd: "/x", generation: 7 } } }),
    );
    expect(renders).toBe(first);
    await act(async () =>
      useSessionStore.setState({ views: { a: { ...EMPTY_VIEW, name: "Two", cwd: "/x", generation: 7 } } }),
    );
    expect([renders, page.container.textContent]).toEqual([first + 1, "Two"]);
    await page.unmount();
  });
});
