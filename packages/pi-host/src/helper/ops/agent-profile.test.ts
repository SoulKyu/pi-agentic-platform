import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { SubagentProfileFile } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HelperOpError, type HelperContext } from "../ops.ts";
import { readProfile } from "./agent-profile.ts";

let root: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-profile-")));
  agentDir = join(root, "home", ".pi", "agent");
  cwd = join(root, "home", "work", "proj");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ctxFor = (withCwd = true): Pick<HelperContext, "agentDir" | "cwd"> => ({
  agentDir,
  ...(withCwd ? { cwd } : {}),
});
const file = (name: string, body = `You are ${name}.`, extra = "tools: read, grep\nmodel: some-model\n") =>
  `---\nname: ${name}\ndescription: ${name} does things\n${extra}---\n${body}\n`;
const userDir = () => join(agentDir, "agents");
const projectDir = () => join(cwd, ".pi", "agents");
const put = (dir: string, fileName: string, text: string) => writeFileSync(join(dir, fileName), text);
const trust = () => new ProjectTrustStore(agentDir).set(cwd, true);
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof HelperOpError ? error.code : "other"),
  );

describe("subagents.profile helper read (Task 29b, carry 1)", () => {
  it("reads one file whole: front matter, tools, model and the body as the prompt", async () => {
    put(userDir(), "scout.md", file("scout", "Look around.\nThen answer."));
    const profile = await readProfile(ctxFor(), "scout");
    expect(SubagentProfileFile.parse(profile)).toEqual({
      name: "scout",
      description: "scout does things",
      source: "user",
      tools: ["read", "grep"],
      model: "some-model",
      prompt: "Look around.\nThen answer.",
    });
  });

  it("takes the name from the front matter, never from the file name", async () => {
    put(userDir(), "whatever.md", file("scout"));
    expect((await readProfile(ctxFor(), "scout")).name).toBe("scout");
    expect(await codeOf(readProfile(ctxFor(), "whatever"))).toBe("not_found");
  });

  it("answers not_found for a name no file has, and for a profile marked longTerm", async () => {
    put(userDir(), "lt.md", file("lt", "x", "longTerm: true\n"));
    expect(await codeOf(readProfile(ctxFor(), "nothing"))).toBe("not_found");
    expect(await codeOf(readProfile(ctxFor(), "lt"))).toBe("not_found");
  });

  it("gives no tools when the file lists none, and drops a tool name that is not a name", async () => {
    put(userDir(), "a.md", file("a", "x", ""));
    put(userDir(), "b.md", file("b", "x", "tools: read, ../etc, grep\n"));
    expect((await readProfile(ctxFor(), "a")).tools).toBeNull();
    expect((await readProfile(ctxFor(), "b")).tools).toEqual(["read", "grep"]);
  });

  it("prefers the project's file over the user's, but only while Pi trusts the project", async () => {
    put(userDir(), "shared.md", file("shared", "USER"));
    put(projectDir(), "shared.md", file("shared", "PROJECT"));
    expect(await readProfile(ctxFor(), "shared")).toMatchObject({ source: "user", prompt: "USER" });
    trust();
    expect(await readProfile(ctxFor(), "shared")).toMatchObject({ source: "project", prompt: "PROJECT" });
    expect(await readProfile(ctxFor(false), "shared")).toMatchObject({ source: "user" });
  });

  it("refuses a project-only name while the project is untrusted", async () => {
    put(projectDir(), "reviewer.md", file("reviewer"));
    expect(await codeOf(readProfile(ctxFor(), "reviewer"))).toBe("not_found");
    trust();
    expect((await readProfile(ctxFor(), "reviewer")).source).toBe("project");
  });

  it("refuses two files of one folder with the same name, whatever the order, and never picks one", async () => {
    put(userDir(), "a.md", file("dup", "FIRST"));
    put(userDir(), "b.md", file("dup", "SECOND"));
    expect(await codeOf(readProfile(ctxFor(), "dup"))).toBe("conflict");
    trust();
    put(projectDir(), "x.md", file("dup", "P1"));
    put(projectDir(), "y.md", file("dup", "P2"));
    expect(await codeOf(readProfile(ctxFor(), "dup"))).toBe("conflict");
  });

  it("does not follow a link out of the agents folder", async () => {
    put(join(root, "home"), "evil.md", file("evil"));
    symlinkSync(join(root, "home", "evil.md"), join(userDir(), "evil.md"));
    expect(await codeOf(readProfile(ctxFor(), "evil"))).toBe("not_found");
  });

  it("skips a file over 32 KiB", async () => {
    put(userDir(), "big.md", file("big", "x".repeat(33 * 1024)));
    expect(await codeOf(readProfile(ctxFor(), "big"))).toBe("not_found");
  });
});
