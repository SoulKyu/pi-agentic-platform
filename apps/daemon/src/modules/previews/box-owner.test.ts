import { describe, expect, it } from "vitest";
import { createBoxOwner } from "./box-owner.ts";

const owner = createBoxOwner({
  project: (id) => (id === "0b1c2d3e-0000-4000-8000-000000000001" ? "u1" : null),
  agent: (id) => (id === "atlas-0001" ? "u2" : null),
});

describe("the owner of a box", () => {
  it("is the project's owner or the agent's owner", () => {
    expect(owner({ kind: "project", id: "0b1c2d3e-0000-4000-8000-000000000001" })).toBe("u1");
    expect(owner({ kind: "agent", id: "atlas-0001" })).toBe("u2");
  });

  it("is null for a box nobody owns, whatever its kind", () => {
    expect(owner({ kind: "project", id: "0b1c2d3e-0000-4000-8000-000000000002" })).toBeNull();
    expect(owner({ kind: "agent", id: "nobody-0001" })).toBeNull();
  });
});
