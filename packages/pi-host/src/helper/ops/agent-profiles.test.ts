import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { SubagentsProfilesResult } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperContext } from "../ops.ts";
import { listProfiles } from "./agent-profiles.ts";

const seen = vi.hoisted(() => ({ offline: [] as Array<string | undefined>, read: [] as string[] }));
vi.mock("../pi-file.ts", async (original) => {
  const real = await original<typeof import("../pi-file.ts")>();
  return {
    ...real,
    readPiFile: (...args: Parameters<typeof real.readPiFile>) => {
      seen.read.push(args[0]);
      return real.readPiFile(...args);
    },
  };
});
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const real = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...real,
    parseFrontmatter: (...args: Parameters<typeof real.parseFrontmatter>) => {
      seen.offline.push(process.env.PI_OFFLINE);
      return real.parseFrontmatter(...args);
    },
  };
});

let root: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-profiles-")));
  agentDir = join(root, "home", ".pi", "agent");
  cwd = join(root, "home", "work", "proj");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const NONE = { parse: 0, refused: 0, tooLarge: 0 };
const ctxFor = (withCwd = true): Pick<HelperContext, "agentDir" | "cwd"> => ({
  agentDir,
  ...(withCwd ? { cwd } : {}),
});
const file = (name: string, extra = "", description = `${name} does things`) =>
  `---\nname: ${name}\ndescription: ${description}\ntools: read, grep\nmodel: some-model\n${extra}---\nYou are ${name}.\n`;
const put = (dir: string, fileName: string, text: string) => writeFileSync(join(dir, fileName), text);
const userDir = () => join(agentDir, "agents");
const projectDir = () => join(cwd, ".pi", "agents");
const trust = () => new ProjectTrustStore(agentDir).set(cwd, true);
const names = async (c = ctxFor()) => (await listProfiles(c)).profiles.map((p) => `${p.source}:${p.name}`);

describe("subagents.profiles helper read", () => {
  it("lists the user's agent files with name, description and source, in the contract's shape", async () => {
    put(userDir(), "scout.md", file("scout"));
    put(userDir(), "notes.txt", file("ignored"));
    const result = await listProfiles(ctxFor());
    expect(SubagentsProfilesResult.parse(result)).toEqual({
      profiles: [{ name: "scout", description: "scout does things", source: "user" }],
      truncated: false,
      skipped: NONE,
    });
  });

  it("reads the project's files only while Pi trusts the project", async () => {
    put(userDir(), "scout.md", file("scout"));
    put(projectDir(), "reviewer.md", file("reviewer"));
    expect(await names()).toEqual(["user:scout"]);
    expect(await names(ctxFor(false))).toEqual(["user:scout"]);
    trust();
    expect(await names()).toEqual(["project:reviewer", "user:scout"]);
    expect(await names(ctxFor(false))).toEqual(["user:scout"]);
  });

  it("lets a project file replace a user file of the same name, as Pi's own example does", async () => {
    trust();
    put(userDir(), "a.md", file("shared", "", "from user"));
    put(projectDir(), "a.md", file("shared", "", "from project"));
    expect((await listProfiles(ctxFor())).profiles).toEqual([
      { name: "shared", description: "from project", source: "project" },
    ]);
  });

  it("skips a profile marked longTerm, a file over 32 KiB, a bad name and a file without a description", async () => {
    put(userDir(), "ok.md", file("ok"));
    put(userDir(), "long.md", file("longone", "longTerm: true\n"));
    put(userDir(), "big.md", file("big", "", "d".repeat(33 * 1024)));
    put(userDir(), "bad.md", file("bad name"));
    put(userDir(), "none.md", "---\nname: none\n---\nbody\n");
    put(userDir(), "plain.md", "no front matter\n");
    expect(await names()).toEqual(["user:ok"]);
  });

  it("counts what it skipped by reason, and not a longTerm profile or a non-agent file", async () => {
    put(userDir(), "ok.md", file("ok"));
    put(userDir(), "long.md", file("longone", "longTerm: true\n"));
    put(userDir(), "notes.txt", "x");
    put(userDir(), "yaml.md", "---\nname: [unclosed\ndescription: x\n  - : :\n---\nbody\n");
    put(userDir(), "name.md", file("bad name"));
    put(userDir(), "nodesc.md", "---\nname: nodesc\n---\nbody\n");
    put(userDir(), "plain.md", "no front matter\n");
    put(userDir(), "blank.md", '---\nname: blank\ndescription: "\\u200b\\u0007"\n---\nbody\n');
    put(userDir(), "big1.md", file("big1", "", "d".repeat(33 * 1024)));
    put(userDir(), "big2.md", file("big2", "", "d".repeat(40 * 1024)));
    const outside = join(root, "outside.md");
    writeFileSync(outside, file("planted"));
    symlinkSync(outside, join(userDir(), "planted.md"));
    symlinkSync(join(root, "missing.md"), join(userDir(), "dangling.md"));
    const result = await listProfiles(ctxFor());
    expect(result.profiles.map((p) => p.name)).toEqual(["ok"]);
    expect(result.skipped).toEqual({ parse: 5, refused: 2, tooLarge: 2 });
  });

  it("refuses an oversized file from its size, before reading it", async () => {
    put(userDir(), "big.md", file("big", "", "d".repeat(33 * 1024)));
    put(userDir(), "ok.md", file("ok"));
    seen.read.length = 0;
    await listProfiles(ctxFor());
    expect(seen.read).toEqual([join(userDir(), "ok.md")]);
  });

  it("keeps a file of exactly 32 KiB", async () => {
    const head = file("edge");
    const pad = "x".repeat(32 * 1024 - Buffer.byteLength(head));
    put(userDir(), "edge.md", head + pad);
    expect(await names()).toEqual(["user:edge"]);
  });

  it("reads 64 files of a folder and skips the 65th, saying the list is cut", async () => {
    for (let i = 0; i < 65; i += 1) put(userDir(), `a${String(i).padStart(2, "0")}.md`, file(`a${i}`));
    const result = await listProfiles(ctxFor());
    expect(result.profiles).toHaveLength(64);
    expect(result.profiles.map((p) => p.name)).not.toContain("a64");
    expect(result.truncated).toBe(true);
  });

  it("skips a link out of the folder and a dangling link, keeps the plain file", async () => {
    const outside = join(root, "outside.md");
    writeFileSync(outside, file("planted"));
    symlinkSync(outside, join(userDir(), "planted.md"));
    symlinkSync(join(root, "missing.md"), join(userDir(), "dangling.md"));
    put(userDir(), "real.md", file("real"));
    expect(await names()).toEqual(["user:real"]);
  });

  it("does not follow an agents folder that is a link out of the project", async () => {
    trust();
    rmSync(projectDir(), { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    put(elsewhere, "x.md", file("x"));
    symlinkSync(elsewhere, projectDir());
    expect(await names()).toEqual([]);
  });

  it("returns an empty list when there is no agents folder", async () => {
    rmSync(userDir(), { recursive: true });
    expect(await listProfiles(ctxFor())).toEqual({ profiles: [], truncated: false, skipped: NONE });
  });

  it("reads with Pi's offline switch on, and puts the variable back after", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    put(userDir(), "scout.md", file("scout"));
    seen.offline.length = 0;
    await listProfiles(ctxFor());
    expect(seen.offline).toEqual(["1"]);
    expect(process.env.PI_OFFLINE).toBeUndefined();
  });
});
