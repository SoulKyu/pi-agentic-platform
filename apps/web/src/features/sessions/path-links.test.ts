import { describe, expect, it } from "vitest";
import type { PathScope } from "../../stores/reply-ports.ts";
import { findPaths } from "./path-links.ts";

const plain: PathScope = { base: "/w/p", roots: ["/w/p"], filesRoot: "/w/p", agentId: null };
const box: PathScope = {
  base: "/boxes/b1/project",
  roots: ["/boxes/b1/project"],
  filesRoot: "/boxes/b1/project",
  agentId: null,
};
const agent: PathScope = {
  base: "/agent/home",
  roots: ["/agent/home", "/agent/inbox", "/agent/knowledge"],
  filesRoot: "/agents/a1",
  agentId: "a1",
};
const outside: PathScope = { base: "/w/p/sub", roots: ["/w/p/sub"], filesRoot: "/w/p/other", agentId: null };

const one = (text: string, scope = plain, whole = false) => findPaths(text, scope, whole);

describe("findPaths accepts", () => {
  it.each([
    ["src/app.py", plain, "/w/p/src/app.py", null],
    ["src/app.py:12", plain, "/w/p/src/app.py", 12],
    ["src/app.py:12:5", plain, "/w/p/src/app.py", 12],
    ["README.md", plain, "/w/p/README.md", null],
    [".github/workflows/ci.yml", plain, "/w/p/.github/workflows/ci.yml", null],
    ["/w/p/src/a.ts", plain, "/w/p/src/a.ts", null],
    ["/boxes/b1/project/x.go", box, "/boxes/b1/project/x.go", null],
  ] as const)("%s", (text, scope, path, line) => {
    const spans = one(text, scope);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: text.length, text, path, line });
  });

  it.each([
    ["see src/a.ts.", "src/a.ts", 4],
    ["(src/a.ts)", "src/a.ts", 1],
    ["src/a.ts:", "src/a.ts", 0],
    ["open src/a.ts, then", "src/a.ts", 5],
  ])("%j: trailing punctuation is not part of the span", (text, span, start) => {
    expect(one(text)).toMatchObject([{ text: span, start, end: start + span.length }]);
  });
});

describe("findPaths refuses", () => {
  it.each([
    "../x.ts",
    "src/../x.ts",
    "./x.ts",
    "~/x.ts",
    "//x.ts",
    "/etc/passwd",
    "src/",
    "example.com/a/b",
    "https://x.org/a.ts",
    "Node.js",
    "Next.js",
    "e.g.",
    "1.2.3",
    "src/app.py:0",
    "src/app.py:12345678",
    `src/${"a".repeat(509)}.ts`,
  ])("%j", (text) => {
    expect(one(text)).toEqual([]);
  });

  it("a path of exactly 512 characters is still seen, a 513 one is not", () => {
    const fits = `src/${"a".repeat(505)}.ts`;
    expect(fits).toHaveLength(512);
    expect(one(fits)).toHaveLength(1);
    expect(one(`${fits}x`)).toEqual([]);
  });

  it("a cwd-relative path that leaves the Files root", () => {
    expect(one("src/a.ts", outside)).toEqual([]);
  });
});

describe("findPaths in an agent thread", () => {
  it("maps /agent/ to /agents/<id>/ and resolves relative paths in the home folder", () => {
    expect(one("/agent/home/notes.md", agent)[0]?.path).toBe("/agents/a1/home/notes.md");
    expect(one("notes/today.md", agent)[0]?.path).toBe("/agents/a1/home/notes/today.md");
    expect(one("/agent/knowledge/c.md:3", agent)[0]).toMatchObject({
      path: "/agents/a1/knowledge/c.md",
      line: 3,
    });
  });

  it.each([
    "/agent/.pi/agent/auth.json",
    "/agents/a2/home/x.md",
    "/agent/other/x.md",
    "/agents/a1/home/x.md",
  ])("refuses %s", (text) => {
    expect(one(text, agent)).toEqual([]);
  });
});

describe("findPaths in an agent scope", () => {
  it("never maps a path that is not in the guest's /agent/ tree", () => {
    const odd: PathScope = { base: "/srv", roots: ["/srv"], filesRoot: "/agents/a1", agentId: "a1" };
    expect(one("/srv/x.md", odd)).toEqual([]);
  });
});

describe("findPaths whole", () => {
  it("is exactly one path: a command line has none, a path with a line has one", () => {
    expect(one("rm -rf build/", plain, true)).toEqual([]);
    expect(one("src/a.ts:3", plain, true)).toMatchObject([{ path: "/w/p/src/a.ts", line: 3 }]);
    expect(one("see src/a.ts", plain, true)).toEqual([]);
  });
});

describe("findPaths bounds", () => {
  it("returns 64 spans at most", () => {
    const text = Array.from({ length: 70 }, (_, index) => `src/f${index}.ts`).join(" ");
    const spans = one(text);
    expect(spans).toHaveLength(64);
    expect(spans.at(-1)?.text).toBe("src/f63.ts");
  });

  it("does not look past the first 20 000 units, nor read a token cut by that edge", () => {
    const pad = "x ".repeat(10_000);
    expect(pad).toHaveLength(20_000);
    expect(one(`${pad}src/a.ts`)).toEqual([]);
    expect(one(`src/a.ts ${pad}`)).toHaveLength(1);
    const edge = `${"x ".repeat(9_996)}src/a.tsxxxxxxxxxx`;
    expect(edge.length).toBeGreaterThan(20_000);
    expect(one(edge)).toEqual([]);
  });
});
