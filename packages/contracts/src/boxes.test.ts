import { describe, expect, it } from "vitest";
import {
  BOX_MOUNT,
  BOX_OP_ERRORS,
  BOX_OP_LIMITS,
  BOX_OP_RESULTS,
  BoxOp,
  BoxPhase,
  BoxRef,
  DEFAULT_PROJECT_RESOURCES,
  ProjectHosts,
  ProjectId,
  boxKey,
  parseBoxKey,
  projectBoxPaths,
} from "./boxes.ts";
import { AgentResources } from "./agents-resources.ts";
import { ERROR_CODES, ERROR_MESSAGES } from "./errors.ts";
import { FILE_CHUNK_BYTES } from "./agents-vm.ts";

const ID = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
const PUT = {
  name: "fs.put",
  id: "a".repeat(32),
  path: "/boxes/x/project/a.bin",
  offset: 0,
  data: "AAAA",
  last: true,
  conflict: "skip",
} as const;

describe("box refs", () => {
  it("parses both box kinds and refuses a project id that is not a uuid", () => {
    expect(BoxRef.safeParse({ kind: "agent", id: "helper-0a1b" }).success).toBe(true);
    expect(BoxRef.safeParse({ kind: "project", id: ID }).success).toBe(true);
    expect(BoxRef.safeParse({ kind: "project", id: "helper-0a1b" }).success).toBe(false);
    expect(BoxRef.safeParse({ kind: "agent", id: ID }).success).toBe(false);
    expect(ProjectId.safeParse("not-a-uuid").success).toBe(false);
  });

  it("accepts lowercase uuids only", () => {
    expect(ProjectId.safeParse(ID).success).toBe(true);
    expect(ProjectId.safeParse(ID.toUpperCase()).success).toBe(false);
    expect(BoxRef.safeParse({ kind: "project", id: ID.toUpperCase() }).success).toBe(false);
  });

  it("boxKey and parseBoxKey round-trip", () => {
    for (const box of [
      { kind: "agent", id: "helper-0a1b" },
      { kind: "project", id: ID },
    ] as const) {
      expect(parseBoxKey(boxKey(box))).toEqual(box);
    }
    expect(boxKey({ kind: "project", id: ID })).toBe(`project:${ID}`);
    for (const bad of ["", "project:x", "agent:", `agent:${ID}`, `box:${ID}`, `project:${ID}/x`]) {
      expect(parseBoxKey(bad), bad).toBeNull();
    }
  });
});

describe("box paths and defaults", () => {
  it("projectBoxPaths joins the fixed names", () => {
    const base = `${BOX_MOUNT}/${ID}`;
    expect(projectBoxPaths(base)).toEqual({
      root: base,
      project: `${base}/project`,
      home: `${base}/home`,
      inbox: `${base}/inbox`,
      pi: `${base}/.pi`,
      sessions: `${base}/.pi/sessions`,
      piAgentDir: `${base}/.pi/agent`,
    });
    expect(projectBoxPaths("/x/y/").project).toBe("/x/y/project");
  });

  it("fixes the defaults and limits", () => {
    expect(DEFAULT_PROJECT_RESOURCES).toEqual({ memoryMb: 2048, cpus: 2, diskMb: 8192 });
    expect(AgentResources.safeParse(DEFAULT_PROJECT_RESOURCES).success).toBe(true);
    expect(BOX_OP_LIMITS).toEqual({ inFlight: 8, timeoutMs: 30_000 });
    expect(BoxPhase.options).toEqual(["stopped", "starting", "running"]);
    expect(ProjectHosts.safeParse([]).success).toBe(true);
    expect(ProjectHosts.safeParse(Array.from({ length: 257 }, (_, i) => `h${i}.example`)).success).toBe(
      false,
    );
    expect(BOX_OP_ERRORS).toContain("failed");
  });
});

describe("box ops", () => {
  it("each op schema refuses an unknown key and a data chunk over 2 MiB", () => {
    const valid: unknown[] = [
      { name: "fs.list", path: "/p", showIgnored: false },
      { name: "fs.read", path: "/p/a", offset: 0 },
      { name: "fs.write", path: "/p/a", text: "x", baseEtag: null },
      PUT,
      { name: "fs.get", path: "/p/a", offset: 0 },
      { name: "fs.search", query: "a", limit: 10 },
      { name: "git.status" },
      { name: "git.blob", path: "a/b", side: { kind: "head" } },
      { name: "knowledge.state" },
      { name: "knowledge.enable" },
      { name: "project.config" },
      { name: "git.clone", url: "https://github.com/o/r.git", upstream: null },
      { name: "git.link", url: "https://github.com/o/r.git" },
      { name: "git.unlink" },
      { name: "git.commit", message: "m" },
      { name: "git.push" },
      { name: "github.token", token: "ghs_x", expiresAt: "2026-10-24T10:00:00Z" },
      { name: "github.identity", login: "o", displayName: "o", email: "1+o@users.noreply.github.com" },
      { name: "github.forgetKey" },
    ];
    expect(new Set(valid.map((op) => (op as { name: string }).name))).toEqual(
      new Set(Object.keys(BOX_OP_RESULTS)),
    );
    for (const op of valid) {
      expect(BoxOp.safeParse(op).success, JSON.stringify(op)).toBe(true);
      expect(BoxOp.safeParse({ ...(op as object), extra: 1 }).success, JSON.stringify(op)).toBe(false);
    }
    const over = "A".repeat(Math.ceil(FILE_CHUNK_BYTES / 3) * 4 + 4);
    expect(BoxOp.safeParse({ ...PUT, data: over }).success).toBe(false);
    expect(BoxOp.safeParse({ ...PUT, conflict: "rename" }).success).toBe(false);
    expect(BoxOp.safeParse({ ...PUT, id: "xyz" }).success).toBe(false);
    expect(BoxOp.safeParse({ name: "fs.nope" }).success).toBe(false);
  });

  it("types a result per op name", () => {
    expect(BOX_OP_RESULTS["fs.write"].safeParse({ etag: "b".repeat(32) }).success).toBe(true);
    expect(BOX_OP_RESULTS["fs.put"].safeParse({ done: true, skipped: false }).success).toBe(true);
    expect(BOX_OP_RESULTS["fs.get"].safeParse({ data: "AAAA", size: 3, nextOffset: null }).success).toBe(
      true,
    );
    expect(BOX_OP_RESULTS["git.blob"].safeParse({ text: null, binary: true, truncated: false }).success).toBe(
      true,
    );
    expect(BOX_OP_RESULTS["knowledge.state"].safeParse({ enabled: false, concepts: 0 }).success).toBe(true);
    expect(BOX_OP_RESULTS["knowledge.enable"].safeParse({ enabled: false }).success).toBe(false);
    expect(BOX_OP_RESULTS["project.config"].safeParse({ packages: ["jq"], error: null }).success).toBe(true);
    expect(
      BOX_OP_RESULTS["project.config"].safeParse({ packages: null, error: "bad_packages" }).success,
    ).toBe(true);
    expect(BOX_OP_RESULTS["project.config"].safeParse({ packages: null, error: "other" }).success).toBe(
      false,
    );
  });
});

describe("box_stopped", () => {
  it("box_stopped is a known error code", () => {
    expect(ERROR_CODES).toContain("box_stopped");
    expect(ERROR_MESSAGES.box_stopped).toBe("The project's box is stopped: start it from the project page.");
  });
});
