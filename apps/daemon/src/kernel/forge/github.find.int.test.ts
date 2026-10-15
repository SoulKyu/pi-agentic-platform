import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { type StubAnswer, writeStubForge } from "../../testing/stub-forge.ts";
import { createSystemClock } from "../clock.ts";
import { githubForge } from "./github.ts";
import { prepareForgeDir } from "./port.ts";

let dir: string;
let forgeDir: string;
let stubDir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-forge-find-")));
  forgeDir = join(dir, "forge");
  stubDir = join(dir, "stub");
  mkdirSync(forgeDir, { mode: 0o700 });
  mkdirSync(stubDir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (number: number, cross: boolean) => ({
  number,
  url: `https://github.com/${cross ? "f" : "o"}/r/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  isCrossRepository: cross,
});
const forgeWith = (answers: StubAnswer[]) => {
  const stub = writeStubForge(stubDir, answers);
  const forge = githubForge({
    env: { PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    forgeDir,
    logger: captureLogger().logger,
    clock: createSystemClock(),
  });
  return { stub, forge };
};
const REPO = { host: "github.com", path: "o/r" };

describe("findPr among many pull requests of the same branch name", () => {
  it("finds the lane's own pull request behind 7 newer fork pull requests", async () => {
    const list = [...Array.from({ length: 7 }, (_, at) => entry(100 - at, true)), entry(5, false)];
    const { stub, forge } = forgeWith([{ stdout: JSON.stringify(list) }]);
    expect(await forge.findPr(REPO, "pi/x")).toMatchObject({ ok: true, value: { number: 5, state: "open" } });
    expect(stub.calls()[0]?.argv).toContain("--limit=100");
  });

  it("answers failed, never null, when the whole list is forks: the own pull request may be past it", async () => {
    const list = Array.from({ length: 100 }, (_, at) => entry(500 - at, true));
    const { forge } = forgeWith([{ stdout: JSON.stringify(list) }]);
    expect(await forge.findPr(REPO, "pi/x")).toEqual({ ok: false, outcome: "failed" });
  });

  it("answers null when a short list holds no pull request of the repository", async () => {
    const { forge } = forgeWith([{ stdout: JSON.stringify([entry(9, true)]) }]);
    expect(await forge.findPr(REPO, "pi/x")).toEqual({ ok: true, value: null });
  });

  it("creates without --base for a commit base", async () => {
    const { stub, forge } = forgeWith([{ stdout: "https://github.com/o/r/pull/3\n" }]);
    await forge.createPr(REPO, { head: "pi/x", title: "t", body: "b", draft: false });
    expect(stub.calls()[0]?.argv.some((arg) => arg.startsWith("--base"))).toBe(false);
  });
});

describe("prepareForgeDir", () => {
  it("creates the folder 0700 and answers its real path when the folder is a symlink", () => {
    const home = join(dir, "home");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(join(home, "tmp"), { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, "tmp", "forge"));
    expect(prepareForgeDir(home)).toBe(elsewhere);
  });

  it("creates a missing folder", () => {
    const home = join(dir, "fresh");
    mkdirSync(home);
    expect(prepareForgeDir(home)).toBe(join(home, "tmp", "forge"));
  });
});
