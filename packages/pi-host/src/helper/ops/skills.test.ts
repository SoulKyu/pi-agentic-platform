import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { SkillsListResult } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperContext } from "../ops.ts";
import { fakeInstallers, installCalls } from "./offline-bed.ts";
import { listSkills, setInvocation } from "./skills.ts";

let root: string;
let home: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-skills-")));
  home = join(root, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(home, "work", "proj");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // Pi finds the user's skill folders through HOME: the real one is never read.
  vi.stubEnv("HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const ctxFor = (
  target: string | null = cwd,
): Pick<HelperContext, "agentDir" | "home" | "cwd" | "signal"> => ({
  agentDir,
  home,
  signal: new AbortController().signal,
  ...(target === null ? {} : { cwd: target }),
});
const skillText = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${name} does things\n${extra}---\n# ${name}\n\nBody with --- inside.\n`;
function skillAt(dir: string, name: string, extra = ""): string {
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, "SKILL.md");
  writeFileSync(file, skillText(name, extra));
  return file;
}
const userFile = () => skillAt(join(agentDir, "skills"), "alpha");
const projectFile = () => skillAt(join(cwd, ".pi", "skills"), "proj");
const trust = () => new ProjectTrustStore(agentDir).set(cwd, true);
const confirm = { confirmProtected: true as const };
const names = async (target?: string | null) => (await listSkills(ctxFor(target))).skills.map((s) => s.name);

describe("skills.list (M7R110)", () => {
  it("lists the user's skills and a trusted project's, each with its scope, and matches the contract", async () => {
    const user = userFile();
    const project = projectFile();
    trust();
    const result = await listSkills(ctxFor());
    expect(SkillsListResult.safeParse(result).success).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.skills).toEqual([
      {
        name: "alpha",
        description: "alpha does things",
        path: user,
        scope: "user",
        disableModelInvocation: false,
      },
      {
        name: "proj",
        description: "proj does things",
        path: project,
        scope: "project",
        disableModelInvocation: false,
      },
    ]);
  });

  it("leaves an untrusted project's skills out, and a missing decision counts as untrusted", async () => {
    userFile();
    projectFile();
    expect(await names()).toEqual(["alpha"]);
    new ProjectTrustStore(agentDir).set(cwd, false);
    expect(await names()).toEqual(["alpha"]);
    trust();
    expect(await names()).toEqual(["alpha", "proj"]);
  });

  it("never lists a project-scope skill of the stand-in folder when nothing is trusted", async () => {
    userFile();
    skillAt(join(agentDir, ".pi", "skills"), "stand-in");
    expect(await names(null)).toEqual(["alpha"]);
  });

  it("lists only the user's skills without a folder", async () => {
    userFile();
    projectFile();
    trust();
    expect(await names(null)).toEqual(["alpha"]);
  });

  it("reports the invocation switch from the file", async () => {
    skillAt(join(agentDir, "skills"), "quiet", "disable-model-invocation: true\n");
    expect((await listSkills(ctxFor())).skills[0]?.disableModelInvocation).toBe(true);
  });

  it("cuts a long description to the contract and a huge list to 500 with the truncated flag", async () => {
    for (let i = 0; i < 520; i += 1) skillAt(join(agentDir, "skills"), `s${String(i).padStart(3, "0")}`);
    const result = await listSkills(ctxFor());
    expect(result.skills).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(SkillsListResult.safeParse(result).success).toBe(true);
  });

  it("keeps the answer under the helper record bound even with long fields", async () => {
    const long = "x".repeat(1000);
    for (let i = 0; i < 400; i += 1) {
      mkdirSync(join(agentDir, "skills", `d${i}`), { recursive: true });
      writeFileSync(
        join(agentDir, "skills", `d${i}`, "SKILL.md"),
        `---\nname: d${i}\ndescription: ${long}\n---\n`,
      );
    }
    const result = await listSkills(ctxFor());
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(900_000);
    expect(SkillsListResult.safeParse(result).success).toBe(true);
  });
});

describe("the list byte cap (MC55, T24 M2)", () => {
  it("cuts a list of 500 views that together pass 900 000 bytes, with the truncated flag", async () => {
    // Long paths (a shared prefix of four 250-character folders) and 1 KiB descriptions: 500 views of about 2.3 KB.
    const prefix = join(agentDir, "skills", ...["a", "b", "c", "d"].map((c) => c.repeat(250)));
    const description = "d".repeat(1024);
    for (let i = 0; i < 500; i += 1) {
      mkdirSync(join(prefix, `s${i}`), { recursive: true });
      writeFileSync(
        join(prefix, `s${i}`, "SKILL.md"),
        `---\nname: s${i}\ndescription: ${description}\n---\n`,
      );
    }
    const result = await listSkills(ctxFor());
    expect(result.truncated).toBe(true);
    expect(result.skills.length).toBeGreaterThan(100);
    expect(result.skills.length).toBeLessThan(500);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(900_000);
    expect(SkillsListResult.safeParse(result).success).toBe(true);
  });
});

describe("the settings files the loader reads first are guarded like openSettings does (MC55, T24 M14)", () => {
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (error: { code?: string }) => error.code ?? "other",
    );

  /**
   * Pi reads settings with sync fs, so a FIFO blocks the whole event loop and vitest's timeout cannot fire: the op runs
   * in a child process that is SIGKILLed after 10 s, and a regression fails (signal SIGKILL) instead of hanging.
   */
  function inChild(op: "list" | "set", file: string): { code: string | null; killed: boolean } {
    const here = new URL("./skills.ts", import.meta.url).href;
    const opsHere = new URL("../ops.ts", import.meta.url).href;
    const script = `
      await import(${JSON.stringify(opsHere)});
      const { listSkills, setInvocation } = await import(${JSON.stringify(here)});
      const ctx = JSON.parse(process.env.PROBE_CTX);
      try {
        if (process.env.PROBE_OP === "list") await listSkills(ctx);
        else await setInvocation({ items: [{ path: process.env.PROBE_FILE, disabled: true }] }, ctx);
        console.log(JSON.stringify({ code: "resolved" }));
      } catch (error) {
        console.log(JSON.stringify({ code: error.code ?? "other" }));
      }
      process.exit(0);`;
    const { signal, stdout } = spawnSync(
      process.execPath,
      [
        "--conditions",
        "development",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          PROBE_OP: op,
          PROBE_FILE: file,
          PROBE_CTX: JSON.stringify({ agentDir, home, cwd }),
        },
      },
    );
    const line = stdout.trim().split("\n").pop() ?? "";
    return {
      code: line === "" ? null : (JSON.parse(line) as { code: string }).code,
      killed: signal === "SIGKILL",
    };
  }

  it("refuses a FIFO project settings.json instead of hanging, in the list and the switch", () => {
    const file = userFile();
    trust();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    execFileSync("mkfifo", [join(cwd, ".pi", "settings.json")]);
    expect(inChild("list", file)).toEqual({ code: "config_path_refused", killed: false });
    expect(inChild("set", file)).toEqual({ code: "config_path_refused", killed: false });
  }, 40_000);

  it("refuses an agent settings.json that links out of the agent folder and home", async () => {
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({}));
    symlinkSync(outside, join(agentDir, "settings.json"));
    expect(await code(listSkills(ctxFor(null)))).toBe("config_path_refused");
  });

  it("still lists with plain settings files", async () => {
    userFile();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
    expect(await names(null)).toEqual(["alpha"]);
  });
});

describe("skills.setInvocation (M7R111)", () => {
  it("sets and clears the flag on a listed user skill, changing only that line and keeping the mode", async () => {
    const file = userFile();
    const original = readFileSync(file, "utf8");
    chmodSync(file, 0o640);
    const off = await setInvocation({ items: [{ path: file, disabled: true }] }, ctxFor());
    expect(off).toEqual({ results: [{ path: file, ok: true }] });
    expect(readFileSync(file, "utf8")).toBe(
      original.replace("---\n#", "disable-model-invocation: true\n---\n#"),
    );
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect((await listSkills(ctxFor())).skills[0]?.disableModelInvocation).toBe(true);
    await setInvocation({ items: [{ path: file, disabled: false }] }, ctxFor());
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("answers not_found for a path the loader did not list, and edits nothing (never an arbitrary .md)", async () => {
    userFile();
    const stray = join(root, "notes.md");
    writeFileSync(stray, skillText("stray"));
    const before = readFileSync(stray, "utf8");
    const result = await setInvocation(
      {
        items: [
          { path: stray, disabled: true },
          { path: join(root, "missing", "SKILL.md"), disabled: true },
        ],
      },
      ctxFor(),
    );
    expect(result.results.map((row) => row.code)).toEqual(["not_found", "not_found"]);
    expect(readFileSync(stray, "utf8")).toBe(before);
  });

  it("does not edit the skill of an untrusted project, even when its path is given", async () => {
    const file = projectFile();
    const before = readFileSync(file, "utf8");
    const result = await setInvocation({ items: [{ path: file, disabled: true }], ...confirm }, ctxFor());
    expect(result.results).toEqual([{ path: file, ok: false, code: "not_found" }]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("asks the protected-file confirmation for a project skill, per item, and still switches the others", async () => {
    trust();
    const user = userFile();
    const project = projectFile();
    const before = readFileSync(project, "utf8");
    const refused = await setInvocation(
      {
        items: [
          { path: project, disabled: true },
          { path: user, disabled: true },
        ],
      },
      ctxFor(),
    );
    expect(refused.results).toEqual([
      { path: project, ok: false, code: "protected_path" },
      { path: user, ok: true },
    ]);
    expect(readFileSync(project, "utf8")).toBe(before);
    const done = await setInvocation({ items: [{ path: project, disabled: true }], ...confirm }, ctxFor());
    expect(done.results).toEqual([{ path: project, ok: true }]);
    expect(readFileSync(project, "utf8")).toContain("disable-model-invocation: true");
  });

  it("refuses a key spread over several lines instead of rewriting it (config_invalid)", async () => {
    const file = skillAt(join(agentDir, "skills"), "folded", "disable-model-invocation: >\n  true\n");
    const before = readFileSync(file, "utf8");
    const result = await setInvocation({ items: [{ path: file, disabled: false }] }, ctxFor());
    expect(result.results).toEqual([{ path: file, ok: false, code: "config_invalid" }]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses a file over 256 KiB (config_invalid)", async () => {
    const file = userFile();
    writeFileSync(file, `${skillText("alpha")}${"y".repeat(256 * 1024)}`);
    const result = await setInvocation({ items: [{ path: file, disabled: true }] }, ctxFor());
    expect(result.results).toEqual([{ path: file, ok: false, code: "config_invalid" }]);
  });

  it("refuses a SKILL.md that is a link leading out of its folder, and writes nothing there", async () => {
    const outside = join(root, "outside.md");
    writeFileSync(outside, skillText("linked"));
    mkdirSync(join(agentDir, "skills", "linked"), { recursive: true });
    const file = join(agentDir, "skills", "linked", "SKILL.md");
    symlinkSync(outside, file);
    const result = await setInvocation({ items: [{ path: file, disabled: true }] }, ctxFor());
    expect(result.results).toEqual([{ path: file, ok: false, code: "config_path_refused" }]);
    expect(readFileSync(outside, "utf8")).toBe(skillText("linked"));
  });

  it("refuses a file with another hard link, so the other name never keeps stale text", async () => {
    const file = userFile();
    linkSync(file, join(root, "twin.md"));
    const result = await setInvocation({ items: [{ path: file, disabled: true }] }, ctxFor());
    expect(result.results).toEqual([{ path: file, ok: false, code: "config_path_refused" }]);
    expect(readFileSync(join(root, "twin.md"), "utf8")).toBe(skillText("alpha"));
  });
});

describe("skills run offline (MC52)", () => {
  it("never installs a missing configured package: no npm or git call, the list still answers", async () => {
    userFile();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pap-missing-pkg", "git:github.com/o/missing-pkg"] }),
    );
    const log = join(root, "installers.log");
    vi.stubEnv("PATH", fakeInstallers(join(root, "bin"), log));
    expect(await names()).toEqual(["alpha"]);
    const file = userFile();
    const result = await setInvocation({ items: [{ path: file, disabled: true }] }, ctxFor());
    expect(result.results).toEqual([{ path: file, ok: true }]);
    expect(installCalls(log)).toEqual([]);
  });
});
