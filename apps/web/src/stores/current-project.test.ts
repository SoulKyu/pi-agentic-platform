// @vitest-environment happy-dom
import type { ProjectSummary } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const project = { id: "p1", root: "/w/p1", name: "p1", position: 1, sessions: 1 } satisfies ProjectSummary;

async function freshStore() {
  vi.resetModules();
  return import("./current-project.ts");
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("the current project, per device", () => {
  it("stores the choice as { v: 1, projectId } and a fresh store reads it back", async () => {
    const first = await freshStore();
    first.useCurrentProject.getState().choose("p1");
    expect(localStorage.getItem("pap.project.v1")).toBe('{"v":1,"projectId":"p1"}');
    expect((await freshStore()).useCurrentProject.getState().projectId).toBe("p1");
  });

  it("choosing All projects stores null and reads back as none", async () => {
    const first = await freshStore();
    first.useCurrentProject.getState().choose("p1");
    first.useCurrentProject.getState().choose(null);
    expect(localStorage.getItem("pap.project.v1")).toBe('{"v":1,"projectId":null}');
    expect((await freshStore()).useCurrentProject.getState().projectId).toBeNull();
  });

  it.each([
    ["garbage", "not json"],
    ["another version", '{"v":2,"projectId":"p1"}'],
    ["an empty id", '{"v":1,"projectId":""}'],
    ["an id over 128 characters", JSON.stringify({ v: 1, projectId: "x".repeat(129) })],
    ["a number", '{"v":1,"projectId":3}'],
  ])("%s reads as none", async (_name, stored) => {
    localStorage.setItem("pap.project.v1", stored);
    expect((await freshStore()).useCurrentProject.getState().projectId).toBeNull();
  });

  it("an id of exactly 128 characters is kept", async () => {
    const id = "x".repeat(128);
    localStorage.setItem("pap.project.v1", JSON.stringify({ v: 1, projectId: id }));
    expect((await freshStore()).useCurrentProject.getState().projectId).toBe(id);
  });

  it("a refused write keeps the choice for this page and sets storageRefused; the next good write clears it", async () => {
    const { useCurrentProject } = await freshStore();
    const stored = new Map<string, string>();
    let full = true;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (full) throw new DOMException("full", "QuotaExceededError");
        stored.set(key, value);
      },
    });
    useCurrentProject.getState().choose("p1");
    expect(useCurrentProject.getState().projectId).toBe("p1");
    expect(useCurrentProject.getState().storageRefused).toBe(true);
    full = false;
    useCurrentProject.getState().choose("p1");
    expect(useCurrentProject.getState().storageRefused).toBe(false);
    expect(stored.get("pap.project.v1")).toBe('{"v":1,"projectId":"p1"}');
  });

  it("effectiveProjectId is the stored id only when the store holds that project", async () => {
    const { effectiveProjectId } = await freshStore();
    expect(effectiveProjectId("p1", new Map())).toBeNull();
    expect(effectiveProjectId("p1", new Map([["p1", project]]))).toBe("p1");
    expect(effectiveProjectId(null, new Map([["p1", project]]))).toBeNull();
  });
});
