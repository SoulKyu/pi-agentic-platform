// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { sessionSnapshot } from "../testing/session-snapshot.ts";
import { useSessionStore } from "./session-store.ts";
import { useViewLabels } from "./view-labels-store.ts";

beforeEach(() => {
  useViewLabels.setState({ labels: {} });
  useSessionStore.setState({ views: {} });
});

describe("view labels", () => {
  it("renders again when a name or folder changes, never for another change", async () => {
    let renders = 0;
    function Probe() {
      renders++;
      return <p>{useViewLabels((state) => state.labels).a?.name ?? "-"}</p>;
    }
    const { put } = useViewLabels.getState();
    put("a", { name: "One", cwd: "/x" });
    const page = await mount(<Probe />);
    const first = renders;
    await act(async () => put("a", { name: "One", cwd: "/x" }));
    expect(renders).toBe(first);
    await act(async () => put("a", { name: "Two", cwd: "/x" }));
    expect([renders, page.container.textContent]).toEqual([first + 1, "Two"]);
    await page.unmount();
  });

  it("the session store writes the label of a loaded view and nothing for one that is not loaded", () => {
    useSessionStore.getState().apply("a", { kind: "name", name: "Early" });
    expect(useViewLabels.getState().labels).toEqual({});
    useSessionStore.getState().apply("a", sessionSnapshot({ name: "Fix", cwd: "/w/a" }));
    expect(useViewLabels.getState().labels["a"]).toEqual({ name: "Fix", cwd: "/w/a" });
  });
});
