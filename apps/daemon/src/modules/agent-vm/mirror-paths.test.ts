import { describe, expect, it } from "vitest";
import { mirrorFileOf, mirrorPathOf } from "./mirror-paths.ts";

describe("mirrorPathOf (R23)", () => {
  it("is <papHome>/agents/.mirrors/<agent id>/<file>", () => {
    expect(mirrorPathOf("/p", "atlas-1a2b", "2026-10-19_x.jsonl")).toBe(
      "/p/agents/.mirrors/atlas-1a2b/2026-10-19_x.jsonl",
    );
  });
  it.each(["../x.jsonl", "a/b.jsonl", "x.json", "", ".hidden.jsonl", "a\\b.jsonl"])("refuses %j", (file) => {
    expect(() => mirrorPathOf("/p", "atlas-1a2b", file)).toThrow();
  });
  it("refuses an agent id that is not one folder name", () => {
    expect(() => mirrorPathOf("/p", "../x", "a.jsonl")).toThrow();
    expect(() => mirrorPathOf("/p", "", "a.jsonl")).toThrow();
  });
});

describe("mirrorFileOf", () => {
  const row = (piPath: string | null, agentId: string | undefined = "atlas-1a2b") => ({ piPath, agentId });
  it("is the basename of a path under the agent's mirror folder", () => {
    expect(mirrorFileOf("/p", row("/p/agents/.mirrors/atlas-1a2b/s.jsonl"))).toBe("s.jsonl");
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
