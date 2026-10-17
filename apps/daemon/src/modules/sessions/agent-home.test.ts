import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentHomeOf, agentScratchOf } from "./agent-home.ts";

const ID = "atlas-1a2b";
const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
let root: string;
let papHome: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-agent-home-")));
  papHome = join(root, "pap");
  mkdirSync(join(papHome, "agents"), { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as PapError).code;
  }
};
const home = () => join(papHome, "agents", ID);
const mode = (path: string) => statSync(path).mode & 0o777;

describe("agentHomeOf (M11R51)", () => {
  it("gives the path of a private folder of the daemon's user", () => {
    mkdirSync(home(), { mode: 0o700 });
    expect(agentHomeOf(papHome, ID)).toBe(home());
  });

  it("makes a home the agent opened up (chmod 755) private again, and says so once (RT-21)", () => {
    mkdirSync(home());
    chmodSync(home(), 0o755);
    let repaired = 0;
    expect(agentHomeOf(papHome, ID, () => (repaired += 1))).toBe(home());
    expect(mode(home())).toBe(0o700);
    expect(repaired).toBe(1);
    agentHomeOf(papHome, ID, () => (repaired += 1));
    expect(repaired).toBe(1);
  });

  it("refuses a link, never following it, and leaves the target alone", () => {
    const target = join(root, "elsewhere");
    mkdirSync(target, { mode: 0o755 });
    symlinkSync(target, home());
    expect(codeOf(() => agentHomeOf(papHome, ID))).toBe("invalid_cwd");
    expect(mode(target)).toBe(0o755);
  });

  it("refuses a home behind a linked agents folder, at launch", () => {
    const away = join(root, "away");
    mkdirSync(join(away, ID), { recursive: true, mode: 0o700 });
    rmSync(join(papHome, "agents"), { recursive: true });
    symlinkSync(away, join(papHome, "agents"));
    expect(codeOf(() => agentHomeOf(papHome, ID))).toBe("invalid_cwd");
  });

  it("refuses a file and a missing entry", () => {
    writeFileSync(home(), "x");
    expect(codeOf(() => agentHomeOf(papHome, ID))).toBe("invalid_cwd");
    rmSync(home());
    expect(codeOf(() => agentHomeOf(papHome, ID))).toBe("invalid_cwd");
  });

  it("answers not_found for an id that is not an agent id", () => {
    expect(codeOf(() => agentHomeOf(papHome, "../x"))).toBe("not_found");
  });

  it("returns the real path when $PAP_HOME is spelled through a link", () => {
    mkdirSync(home(), { mode: 0o700 });
    const spelled = join(root, "pap-link");
    symlinkSync(papHome, spelled);
    expect(agentHomeOf(spelled, ID)).toBe(home());
  });
});

describe("agentScratchOf (W5-R4)", () => {
  const scratch = () => join(papHome, "agents", ".runs", ID, TASK);
  it("accepts the task's own folder under .runs/<agent>/", () => {
    mkdirSync(scratch(), { recursive: true, mode: 0o700 });
    expect(agentScratchOf(papHome, ID, scratch())).toBe(scratch());
  });

  it.each([
    ["the home", () => home()],
    ["another agent's runs", () => join(papHome, "agents", ".runs", "other-0000", TASK)],
    ["a folder two levels down", () => join(papHome, "agents", ".runs", ID, TASK, "u")],
    ["a folder that is no task id", () => join(papHome, "agents", ".runs", ID, "t")],
    ["a relative path", () => "x"],
  ])("refuses %s", (_name, path) => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    mkdirSync(join(papHome, "agents", ".runs", ID, TASK, "u"), { recursive: true });
    mkdirSync(join(papHome, "agents", ".runs", "other-0000", TASK), { recursive: true });
    mkdirSync(join(papHome, "agents", ".runs", ID, "t"), { recursive: true });
    expect(codeOf(() => agentScratchOf(papHome, ID, path()))).toBe("invalid_cwd");
  });

  it("refuses a link, and a folder behind a linked .runs/<agent>", () => {
    mkdirSync(join(papHome, "agents", ".runs", ID), { recursive: true });
    mkdirSync(join(root, "away"));
    symlinkSync(join(root, "away"), scratch());
    expect(codeOf(() => agentScratchOf(papHome, ID, scratch()))).toBe("invalid_cwd");
    rmSync(join(papHome, "agents", ".runs", ID), { recursive: true });
    mkdirSync(join(root, "away", TASK), { recursive: true });
    symlinkSync(join(root, "away"), join(papHome, "agents", ".runs", ID));
    expect(codeOf(() => agentScratchOf(papHome, ID, scratch()))).toBe("invalid_cwd");
  });
});
