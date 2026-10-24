import { describe, expect, it } from "vitest";
import { mirrorFileOf, mirrorFolderOf, mirrorPathOf, projectMirrorPathOf } from "./mirror-paths.ts";

const PROJECT = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";

describe("mirrorPathOf (R23)", () => {
  it("is <papHome>/agents/.mirrors/<agent id>/<file>", () => {
    expect(mirrorPathOf("/p", "atlas-1a2b", "2026-10-19_x.jsonl")).toBe(
      "/p/agents/.mirrors/atlas-1a2b/2026-10-19_x.jsonl",
    );
  });
  it.each(["../x.jsonl", "a/b.jsonl", "x.json", "", ".hidden.jsonl", "a\\b.jsonl"])("refuses %j", (file) => {
    expect(() => mirrorPathOf("/p", "atlas-1a2b", file)).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
  });
  it("refuses an agent id that is not one folder name", () => {
    expect(() => mirrorPathOf("/p", "../x", "a.jsonl")).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(() => mirrorPathOf("/p", "", "a.jsonl")).toThrow(expect.objectContaining({ code: "bad_request" }));
  });
});

describe("mirrorFileOf", () => {
  const row = (piPath: string | null, agentId: string | undefined = "atlas-1a2b") => ({ piPath, agentId });
  it("is the basename of a path under the agent's mirror folder", () => {
    expect(mirrorFileOf("/p", row("/p/agents/.mirrors/atlas-1a2b/s.jsonl"))).toBe("s.jsonl");
  });
  it("is null when the folder only looks like the mirror folder (a sibling with the same prefix, a dot-dot spelling)", () => {
    expect(mirrorFileOf("/p", row("/p/agents/.mirrors/atlas-1a2b-evil/s.jsonl"))).toBeNull();
    expect(mirrorFileOf("/p", row("/p/agents/.mirrors/atlas-1a2b/../other-1a2b/s.jsonl"))).toBeNull();
  });
  it("is null for a host session file, another agent's mirror, a nested path or no file", () => {
    expect(mirrorFileOf("/p", row("/home/u/.pi/agent/sessions/s.jsonl"))).toBeNull();
    expect(mirrorFileOf("/p", row("/p/agents/.mirrors/other-1a2b/s.jsonl"))).toBeNull();
    expect(mirrorFileOf("/p", row("/p/agents/.mirrors/atlas-1a2b/d/s.jsonl"))).toBeNull();
    expect(mirrorFileOf("/p", row("/p/agents/.mirrors/atlas-1a2b/s.txt"))).toBeNull();
    expect(mirrorFileOf("/p", row(null))).toBeNull();
    expect(
      mirrorFileOf("/p", { piPath: "/p/agents/.mirrors/atlas-1a2b/s.jsonl", agentId: undefined }),
    ).toBeNull();
  });
});

describe("a project box's mirrors", () => {
  it("puts a project mirror under boxes/.mirrors/<id>", () => {
    expect(projectMirrorPathOf("/p", PROJECT, "s.jsonl")).toBe(`/p/boxes/.mirrors/${PROJECT}/s.jsonl`);
    expect(mirrorFolderOf("/p", PROJECT)).toBe(`/p/boxes/.mirrors/${PROJECT}`);
    expect(mirrorFolderOf("/p", "atlas-1a2b")).toBe("/p/agents/.mirrors/atlas-1a2b");
  });
  it("refuses a project id that is not a lowercase uuid, and a file that is a path", () => {
    for (const id of ["../x", PROJECT.toUpperCase(), ""])
      expect(() => projectMirrorPathOf("/p", id, "a.jsonl")).toThrow(
        expect.objectContaining({ code: "bad_request" }),
      );
    expect(() => projectMirrorPathOf("/p", PROJECT, "../a.jsonl")).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
  });
  it("finds the file of a row under its own project's folder only", () => {
    const row = (piPath: string, projectId = PROJECT) => ({ piPath, projectId });
    expect(mirrorFileOf("/p", row(`/p/boxes/.mirrors/${PROJECT}/s.jsonl`))).toBe("s.jsonl");
    expect(mirrorFileOf("/p", row(`/p/boxes/.mirrors/${PROJECT}/../other/s.jsonl`))).toBeNull();
    expect(mirrorFileOf("/p", row(`/p/agents/.mirrors/${PROJECT}/s.jsonl`))).toBeNull();
    expect(mirrorFileOf("/p", row(`/p/boxes/.mirrors/${PROJECT}/s.jsonl`, "not-a-uuid"))).toBeNull();
  });
});
