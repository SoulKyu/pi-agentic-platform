import { describe, expect, it } from "vitest";
import { boxProject } from "../testing/box-fixtures.ts";
import { shellProject } from "../testing/shell-snapshot.ts";
import { boxProjectOf, phaseOf } from "./box-phase.ts";

const projects = new Map([
  ["b1", boxProject("running")],
  ["h1", shellProject({ id: "h1", root: "/w/api" })],
]);

describe("boxProjectOf", () => {
  it("finds the box project that holds a path, never a look-alike", () => {
    expect(boxProjectOf(projects, "/boxes/b1/project")?.id).toBe("b1");
    expect(boxProjectOf(projects, "/boxes/b1/project/src/a.ts")?.id).toBe("b1");
    expect(boxProjectOf(projects, "/boxes/b1/projectX")).toBeUndefined();
    expect(boxProjectOf(projects, "/boxes/b2/project")).toBeUndefined();
    expect(boxProjectOf(projects, "/w/api")).toBeUndefined();
  });

  it("reads the phase, and a box the stream has not described is stopped", () => {
    expect(phaseOf(boxProject("running"))).toBe("running");
    expect(phaseOf(shellProject({ id: "b3", kind: "box", root: "/boxes/b3/project" }))).toBe("stopped");
  });
});
