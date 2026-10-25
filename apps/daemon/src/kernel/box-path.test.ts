import { describe, expect, it, vi } from "vitest";
import { assertBoxOnly, routeBoxPath } from "./box-path.ts";
import type { ProjectBoxSource } from "./boxes.ts";
import { createFakeProjectBoxSource } from "./testing/fake-boxes.ts";

const ROOT = "/boxes/p1/project";
const row = (ownerId: string) => ({
  ownerId,
  root: ROOT,
  resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
  hosts: [],
  deleting: false,
});
const source = createFakeProjectBoxSource({ p1: row("m1") });
const member = { isMember: (id: string) => id === "m1" };

describe("assertBoxOnly", () => {
  it("refuses a member's host path and accepts their box path and its children, returning the match", () => {
    for (const path of [
      "/home/ubuntu",
      "/",
      "/boxes/p1",
      "/boxes/p1/projectX",
      `${ROOT}/../x`,
      `${ROOT}//x`,
    ]) {
      expect(() => assertBoxOnly(member, source, "m1", path)).toThrow(
        expect.objectContaining({ code: "forbidden" }),
      );
    }
    expect(assertBoxOnly(member, source, "m1", ROOT)).toEqual({ projectId: "p1", root: ROOT });
    expect(assertBoxOnly(member, source, "m1", `${ROOT}/src/a.ts`)).toEqual({ projectId: "p1", root: ROOT });
  });

  it("refuses another member's box and a member with no box source bound", () => {
    expect(() => assertBoxOnly({ isMember: () => true }, source, "m2", ROOT)).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => assertBoxOnly(member, undefined, "m1", ROOT)).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
  });

  it("gates an id that is not the owner, an unknown or deleted user included", () => {
    const failsClosed = { isMember: (id: string) => id !== "owner-1" };
    const spy = vi.fn(() => null);
    expect(() => assertBoxOnly(failsClosed, { ...source, byPath: spy }, "ghost", "/home/ubuntu")).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(assertBoxOnly(failsClosed, source, "owner-1", "/home/ubuntu")).toBeNull();
  });

  it("never gates the owner", () => {
    const calls = vi.fn(() => null);
    const spy: ProjectBoxSource = { ...source, byPath: calls };
    expect(assertBoxOnly(member, spy, "u1", "/home/ubuntu")).toBeNull();
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("routeBoxPath", () => {
  it("a box removed between the gate and the routing is refused, never resolved on the host", () => {
    let present = true;
    const vanishing: ProjectBoxSource = {
      ...source,
      byPath: (ownerId, path) => (present ? source.byPath(ownerId, path) : null),
    };
    const gated = routeBoxPath(member, vanishing, "m1", `${ROOT}/a`);
    expect(gated).toEqual({ projectId: "p1", root: ROOT });
    present = false;
    expect(() => routeBoxPath(member, vanishing, "m1", `${ROOT}/a`)).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
  });

  it("the owner keeps the host fall-through", () => {
    expect(routeBoxPath(member, source, "u1", "/home/ubuntu")).toBeNull();
  });
});
