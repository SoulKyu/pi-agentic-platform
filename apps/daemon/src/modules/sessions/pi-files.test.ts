import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileSizeOrZero, isPiSessionFile } from "./pi-files.ts";

describe("isPiSessionFile", () => {
  const agent = "/home/u/.pi/agent";

  it("accepts a JSONL file under the agent directory's sessions", () => {
    expect(isPiSessionFile(agent, `${agent}/sessions/--w--/2026-10-10_abc.jsonl`)).toBe(true);
  });

  it.each([
    ["a file outside the sessions directory", `${agent}/auth.json`],
    ["another directory", "/etc/passwd"],
    ["a path that climbs out", `${agent}/sessions/../auth.jsonl`],
    ["a sibling that shares the prefix", `${agent}/sessions-old/x.jsonl`],
    ["a file that is not JSONL", `${agent}/sessions/x/y.txt`],
    ["a relative path", "sessions/x/y.jsonl"],
    ["an empty string", ""],
    ["a path with a NUL byte", `${agent}/sessions/x/y\0.jsonl`],
    ["the sessions directory itself", `${agent}/sessions`],
  ])("refuses %s", (_label, path) => {
    expect(isPiSessionFile(agent, path)).toBe(false);
  });
});

describe("isPiSessionFile on real paths", () => {
  let root: string;
  let agentDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pap-pilinks-"));
    agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "sessions", "--w--"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a session file that is a link to somewhere outside the sessions directory", () => {
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, "");
    const link = join(agentDir, "sessions", "--w--", "evil.jsonl");
    symlinkSync(outside, link);
    expect(isPiSessionFile(agentDir, link)).toBe(false);
  });

  it("refuses a file that does not exist yet below a folder that is a link to the outside", () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside);
    symlinkSync(outside, join(agentDir, "sessions", "--link--"));
    expect(isPiSessionFile(agentDir, join(agentDir, "sessions", "--link--", "new.jsonl"))).toBe(false);
  });

  it("accepts a file under an agent directory reached through a link", () => {
    const linkedAgent = join(root, "agent-link");
    symlinkSync(agentDir, linkedAgent);
    expect(isPiSessionFile(linkedAgent, join(linkedAgent, "sessions", "--w--", "a.jsonl"))).toBe(true);
  });
});

describe("fileSizeOrZero", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-pifiles-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is the size of a file, and zero for a file that does not exist yet", () => {
    writeFileSync(join(dir, "a.jsonl"), "12345");
    expect(fileSizeOrZero(join(dir, "a.jsonl"))).toBe(5);
    expect(fileSizeOrZero(join(dir, "missing.jsonl"))).toBe(0);
  });
});
