import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAP_SENSITIVE_NAMES, PROTECTED_BASENAMES, PROTECTED_SEGMENTS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReadTarget } from "./read-target.ts";
import { checkEditTarget } from "./target-path.ts";

let root = "";
let cwd = "";
let papHome = "";
let agentDir = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pap-lists-")));
  cwd = join(root, "project");
  papHome = join(root, "pap");
  agentDir = join(root, "agent");
  await Promise.all([cwd, papHome, agentDir].map((dir) => mkdir(dir)));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("contracts' protected lists against pi-host's own checks", () => {
  it.each([...PROTECTED_SEGMENTS])("treats the folder %s as protected for an edit", async (segment) => {
    const verdict = await checkEditTarget(join(cwd, segment, "x"), cwd, []);
    expect(verdict).toMatchObject({ auto: false, review: { why: "protected path" } });
  });

  it.each([...PROTECTED_BASENAMES])("treats the file %s as protected for an edit", async (name) => {
    const verdict = await checkEditTarget(join(cwd, name), cwd, []);
    expect(verdict).toMatchObject({ auto: false, review: { why: "protected path" } });
  });

  it.each([...PAP_SENSITIVE_NAMES])("treats %s in pap's home as unreadable", async (name) => {
    const verdict = await checkReadTarget("read", { path: join(papHome, name) }, { cwd, papHome, agentDir });
    expect(verdict?.why).toBe("protected path");
  });
});
