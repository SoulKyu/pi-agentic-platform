import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createKataImages } from "./kata-images.ts";
import { type ProfileJob, type ProfileOutcome, runProfileJob } from "./profile-job.ts";
import { outcomeOf, threadProfileRunner } from "./profile-runner.ts";
import { createFakeVmd } from "./testing/fake-vmd.ts";

/*
 * Mutants (final review I4), run for real in the report: "fingerprint without mtimes" and "always unchanged" (the changed-mtime
 * case), "salt without the secrets" (the secrets case), "no settle window" (the recent-file case), "thread answer not
 * checked" (the nonsense case), "skip never taken" (the unchanged case).
 */
const NODE = `docker.io/library/node@sha256:${"9".repeat(64)}`;
const BASE = `pap-agent-base-${"c".repeat(64)}`;
let root: string;
let clock: FakeClock;
let secrets: string[];
let outcomes: ProfileOutcome["kind"][];

const dirs = () => ({ agent: join(root, "agent"), home: join(root, "pap") });
const out = () => join(dirs().home, "vm", "build", "profile", "pi-agent");
const skill = () => join(dirs().agent, "skills", "x", "SKILL.md");
const setMtime = (path: string, ms: number) => utimesSync(path, ms / 1000, ms / 1000);

function make() {
  const { agent, home } = dirs();
  return createKataImages({
    client: createFakeVmd(),
    clock,
    logger: silentLogger,
    papHome: home,
    agentDir: agent,
    bundleRoot: join(root, "bundle"),
    nodeImage: NODE,
    weekFile: join(home, "vm", "base-week"),
    secrets: () => secrets,
    entries: { record: () => {}, forget: () => {}, held: () => [] },
    profileRunner: (job) => {
      const outcome = runProfileJob(job);
      outcomes.push(outcome.kind);
      return Promise.resolve(outcome);
    },
    notice: () => {},
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-final-profile-"));
  const { agent } = dirs();
  mkdirSync(join(agent, "skills", "x"), { recursive: true });
  mkdirSync(join(root, "bundle"), { recursive: true });
  writeFileSync(join(root, "bundle", "package.json"), "{}");
  writeFileSync(join(agent, "settings.json"), "{}");
  writeFileSync(skill(), "a skill");
  // Every input is older than the fake clock by far, as a profile edited long ago is.
  for (const path of [
    agent,
    join(agent, "skills"),
    join(agent, "skills", "x"),
    join(agent, "settings.json"),
    skill(),
  ])
    setMtime(path, Date.UTC(2026, 0, 1));
  clock = createFakeClock(Date.UTC(2026, 9, 20));
  secrets = [];
  outcomes = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the profile is prepared again only when its inputs changed (final review I4)", () => {
  // Mutant: the skip never taken.
  it("copies, scans and hashes nothing when the fingerprint is unchanged", async () => {
    const images = make();
    await images.resolve("a-0001", [], "thread");
    writeFileSync(join(out(), "planted-by-the-test"), "x");
    await clock.advance(31_000);
    await images.resolve("b-0002", [], "thread");
    expect(outcomes).toEqual(["made", "unchanged"]);
    expect(existsSync(join(out(), "planted-by-the-test"))).toBe(true);
  });

  // Mutants: fingerprint without mtimes; always unchanged.
  it("prepares again after a copied file's mtime changes", async () => {
    const images = make();
    await images.resolve("a-0001", [], "thread");
    writeFileSync(join(out(), "planted-by-the-test"), "x");
    setMtime(skill(), Date.UTC(2026, 1, 1));
    await clock.advance(31_000);
    await images.resolve("b-0002", [], "thread");
    expect(outcomes).toEqual(["made", "made"]);
    expect(existsSync(join(out(), "planted-by-the-test"))).toBe(false);
  });

  // The folder's own mtime is put back: only the new file's entry can tell.
  it.each([
    ["the agent folder's top level", () => join(dirs().agent, "web-search.json"), () => dirs().agent],
    [
      "a copied package folder",
      () => join(dirs().agent, "skills", "x", "more.md"),
      () => join(dirs().agent, "skills", "x"),
    ],
  ])("prepares again after a file is added to %s, then settles", async (_label, file, folder) => {
    const images = make();
    await images.resolve("a-0001", [], "thread");
    writeFileSync(file(), "{}");
    setMtime(file(), Date.UTC(2026, 0, 1));
    setMtime(folder(), Date.UTC(2026, 0, 1));
    await clock.advance(31_000);
    await images.resolve("b-0002", [], "thread");
    await clock.advance(31_000);
    await images.resolve("c-0003", [], "thread");
    expect(outcomes).toEqual(["made", "made", "unchanged"]);
  });

  // Mutant: the top-level files left out of the fingerprint (the folders' mtimes are put back, so only the file's entry tells).
  it("prepares again after settings.json changes mtime with no other change", async () => {
    const images = make();
    await images.resolve("a-0001", [], "thread");
    setMtime(join(dirs().agent, "settings.json"), Date.UTC(2026, 1, 1));
    await clock.advance(31_000);
    await images.resolve("b-0002", [], "thread");
    expect(outcomes).toEqual(["made", "made"]);
  });

  // Mutant: the salt without the secrets.
  it("prepares again when the known secrets changed", async () => {
    const images = make();
    await images.resolve("a-0001", [], "thread");
    secrets = ["a-new-secret-value"];
    await clock.advance(31_000);
    await images.resolve("b-0002", [], "thread");
    expect(outcomes).toEqual(["made", "made"]);
  });

  // Mutant: no settle window.
  it("does not trust a file modified within seconds of the preparation", async () => {
    setMtime(skill(), clock.now() - 500);
    const images = make();
    await images.resolve("a-0001", [], "thread");
    await clock.advance(31_000);
    await images.resolve("b-0002", [], "thread");
    expect(outcomes).toEqual(["made", "made"]);
  });

  it("prepares again when the tree it left was removed", async () => {
    const images = make();
    await images.resolve("a-0001", [], "thread");
    rmSync(out(), { recursive: true });
    await clock.advance(31_000);
    await images.resolve("b-0002", [], "thread");
    expect(outcomes).toEqual(["made", "made"]);
    expect(existsSync(join(out(), "settings.json"))).toBe(true);
  });
});

describe("the worker thread", () => {
  const job = (): ProfileJob => ({
    agentDir: dirs().agent,
    out: out(),
    secrets,
    papHome: dirs().home,
    baseTag: BASE,
    providers: [],
    nowMs: Date.UTC(2026, 9, 20),
    previous: null,
  });

  it("makes the same tree and tag as the in-process run", async () => {
    const inProcess = runProfileJob(job());
    const thread = await threadProfileRunner(job());
    expect(inProcess.kind).toBe("made");
    expect(thread).toEqual(inProcess);
  });

  // Mutant: the thread's answer taken as it comes.
  it("takes nothing but an outcome from the thread", () => {
    for (const nonsense of [null, 3, "made", {}, { kind: "other" }])
      expect(outcomeOf(nonsense)).toMatchObject({ kind: "failed" });
    expect(outcomeOf({ kind: "unchanged" })).toEqual({ kind: "unchanged" });
  });

  it("answers a planted secret as an outcome, and a missing agent folder as a failure, never a throw or a hang", async () => {
    secrets = ["a-secret-of-8+"];
    writeFileSync(skill(), "key=a-secret-of-8+");
    expect(await threadProfileRunner(job())).toEqual({ kind: "secret", file: "skills/x/SKILL.md" });
    rmSync(dirs().agent, { recursive: true });
    expect((await threadProfileRunner(job())).kind).toBe("failed");
  });
});
