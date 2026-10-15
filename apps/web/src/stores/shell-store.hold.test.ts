import { beforeEach, describe, expect, it } from "vitest";
import { holdProject, useShellStore } from "./shell-store.ts";

beforeEach(() => useShellStore.getState().reset());

describe("holdProject (Add project)", () => {
  it("holds a project the stream has not sent yet, as unused", () => {
    holdProject({ id: "p9", root: "/w/new", name: "new", position: -1 });
    expect(useShellStore.getState().view.projects.get("p9")).toEqual({
      id: "p9",
      root: "/w/new",
      name: "new",
      position: -1,
      sessions: 0,
      unused: true,
    });
  });

  it("keeps the stream's counts for a project the store already holds", () => {
    useShellStore.getState().apply({
      kind: "project",
      project: { id: "p1", root: "/w/api", name: "api", position: 1, sessions: 3 },
    });
    holdProject({ id: "p1", root: "/w/api", name: "API", position: 1 });
    expect(useShellStore.getState().view.projects.get("p1")).toEqual({
      id: "p1",
      root: "/w/api",
      name: "API",
      position: 1,
      sessions: 3,
    });
  });
});
