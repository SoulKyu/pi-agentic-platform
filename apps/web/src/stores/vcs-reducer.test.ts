import { describe, expect, it } from "vitest";
import { vcsStatus } from "../testing/m8-fixtures.ts";
import { EMPTY_VCS, MAX_VCS_ROOTS, reduceVcs } from "./vcs-reducer.ts";

describe("vcs reducer", () => {
  it("a snapshot replaces the entry of its root", () => {
    const first = reduceVcs(EMPTY_VCS, "/w", { kind: "snapshot", status: vcsStatus("/w", { branch: "a" }) });
    const second = reduceVcs(first, "/w", { kind: "snapshot", status: vcsStatus("/w", { branch: "b" }) });
    expect(second.statuses.get("/w")?.branch).toBe("b");
    expect(second.statuses.size).toBe(1);
  });

  it("a snapshot of null says the root is not a repository (the entry exists, empty)", () => {
    const view = reduceVcs(EMPTY_VCS, "/w", { kind: "snapshot", status: null });
    expect(view.statuses.has("/w")).toBe(true);
    expect(view.statuses.get("/w")).toBeNull();
  });

  it("a status event replaces the entry and leaves the other roots alone", () => {
    const base = reduceVcs(EMPTY_VCS, "/other", { kind: "snapshot", status: vcsStatus("/other") });
    const view = reduceVcs(base, "/w", { kind: "status", status: vcsStatus("/w", { ahead: 2 }) });
    expect(view.statuses.get("/w")?.ahead).toBe(2);
    expect(view.statuses.get("/other")).toEqual(vcsStatus("/other"));
  });

  it("an unknown kind leaves the state and is counted", () => {
    const base = reduceVcs(EMPTY_VCS, "/w", { kind: "status", status: vcsStatus("/w") });
    const view = reduceVcs(base, "/w", { kind: "future", status: 1 });
    expect(view.statuses).toBe(base.statuses);
    expect(view.skipped).toBe(1);
    expect(reduceVcs(view, "/w", { kind: "status", status: { root: 3 } }).skipped).toBe(2);
  });

  it("keeps at most MAX_VCS_ROOTS roots, the least recently updated going first", () => {
    let view = EMPTY_VCS;
    for (let index = 0; index < MAX_VCS_ROOTS; index++) {
      view = reduceVcs(view, `/r${index}`, { kind: "status", status: vcsStatus(`/r${index}`) });
    }
    view = reduceVcs(view, "/r0", { kind: "status", status: vcsStatus("/r0", { ahead: 1 }) });
    view = reduceVcs(view, "/new", { kind: "status", status: vcsStatus("/new") });
    expect(view.statuses.size).toBe(MAX_VCS_ROOTS);
    expect(view.statuses.has("/r0")).toBe(true);
    expect(view.statuses.has("/r1")).toBe(false);
    expect(view.statuses.has("/new")).toBe(true);
  });
});
