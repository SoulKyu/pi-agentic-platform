import { DEFAULT_PROJECT_RESOURCES } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeBoxControl, createFakeBoxOps, createFakeProjectBoxSource } from "./fake-boxes.ts";

describe("fake boxes", () => {
  it("fake box ops record calls and return the handler's value", async () => {
    const ops = createFakeBoxOps({ "knowledge.state": () => ({ enabled: true, concepts: 3 }) });
    const signal = new AbortController().signal;
    await expect(ops.call("p1", { name: "knowledge.state" }, signal)).resolves.toEqual({
      enabled: true,
      concepts: 3,
    });
    expect(ops.calls).toEqual([{ projectId: "p1", op: { name: "knowledge.state" }, signal }]);
    await expect(ops.call("p1", { name: "git.status" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("fake box control records calls, moves phases and tells the listeners", async () => {
    const control = createFakeBoxControl({ a: "running" });
    const seen: string[] = [];
    const off = control.onPhase((id, phase) => seen.push(`${id}:${phase}`));
    expect(control.phase("a")).toBe("running");
    expect(control.phase("b")).toBe("stopped");
    await control.start("b");
    await control.dispose("a", 7);
    off();
    await control.purge("b");
    expect(seen).toEqual(["b:running", "a:stopped"]);
    expect(control.calls).toEqual([
      ["start", "b"],
      ["dispose", "a", 7],
      ["purge", "b"],
    ]);
    expect(control.packages("a")).toEqual({ built: [], wanted: null });
    expect(control.rootOf("a")).toBe("/boxes/a/project");
  });

  it("fake project box source finds a box by path on whole segments and records hosts", () => {
    const row = {
      ownerId: "u1",
      root: "/boxes/p1/project",
      resources: DEFAULT_PROJECT_RESOURCES,
      hosts: [],
      deleting: false,
    };
    const source = createFakeProjectBoxSource({ p1: row });
    expect(source.box("p1")).toBe(row);
    expect(source.box("p2")).toBeNull();
    const hit = { projectId: "p1", root: "/boxes/p1/project" };
    expect(source.byPath("u1", "/boxes/p1/project")).toEqual(hit);
    expect(source.byPath("u1", "/boxes/p1/project/src/a.ts")).toEqual(hit);
    expect(source.byPath("u1", "/boxes/p1/projectX")).toBeNull();
    expect(source.byPath("u1", "/boxes/p1/project/../x")).toBeNull();
    expect(source.byPath("u2", "/boxes/p1/project")).toBeNull();
    source.addHost("p1", "example.test", { actor: "user", actorId: "u1" });
    expect(source.added).toEqual([
      { projectId: "p1", host: "example.test", actor: { actor: "user", actorId: "u1" } },
    ]);
  });
});
