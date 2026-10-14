import { PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { CLEAN, handRepo, SAFE_SHELL } from "./cover-bed.ts";
import { BASH_CORPUS } from "./daily-use.corpus.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
  handRepo(bed.cwd, CLEAN);
});
afterAll(() => bed.dispose());

const fullAccess = () => PolicyRules.parse({ ...interactiveRules, approvalMode: "full-access" });
const reads = BASH_CORPUS.filter((entry) => entry.readOnly);
const entries = BASH_CORPUS.filter((entry) => entry.knownFriction === undefined && !entry.readOnly);
const asked = BASH_CORPUS.filter((entry) => entry.knownFriction === undefined);
const friction = BASH_CORPUS.filter((entry) => entry.knownFriction !== undefined);

describe("daily use: bash through the whole pipeline", () => {
  it("has the 52 commands of the owner's list", () => {
    expect(BASH_CORPUS).toHaveLength(52);
    expect(new Set(BASH_CORPUS.map((entry) => entry.command)).size).toBe(52);
  });

  it("marks six commands as read-only", () => {
    expect(reads.map((entry) => entry.command)).toEqual([
      "git status",
      "git diff --stat HEAD~3",
      "git log --oneline -20",
      'rg -n "useEffect" src/',
      "ls -la ~/.config/app/",
      "jq '.dependencies | keys' package.json",
    ]);
  });

  it.each(reads.map((entry) => [entry.command.slice(0, 60), entry.command] as const))(
    "runs without a question in auto-accept-edits: %s",
    async (_name, command) => {
      const h = bed.harness({ shell: SAFE_SHELL });
      expect(await h.run("bash", { command })).toBeUndefined();
      expect(h.asks).toEqual([]);
      expect(h.entries[0]?.stages[2]).toMatchObject({
        stage: "03",
        outcome: "allow",
        reason: "read-only command",
      });
    },
  );

  it.each(entries.map((entry) => [entry.command.slice(0, 60), entry.command] as const))(
    "asks the ordinary grantable question, once per session: %s",
    async (_name, command) => {
      const h = bed.harness({ answers: [{ answer: "session", closed: false }] });
      expect(await h.run("bash", { command })).toBeUndefined();
      expect(h.asks).toHaveLength(1);
      expect([...(h.asks[0]?.answers ?? [])].sort()).toEqual(["always", "deny", "once", "session"]);
      const [stage01, stage02] = h.entries[0]?.stages ?? [];
      expect(stage01?.outcome).toBe("pass");
      expect(["pass", "skip"]).toContain(stage02?.outcome);
      expect(await h.run("bash", { command }, "c2")).toBeUndefined();
      expect(h.asks).toHaveLength(1);
      expect(h.entries[1]).toMatchObject({ decision: "allow", reason: "session rule" });
    },
  );

  it.each(asked.map((entry) => [entry.command.slice(0, 60), entry.command] as const))(
    "runs without a question in full-access: %s",
    async (_name, command) => {
      const h = bed.harness({ rules: fullAccess });
      expect(await h.run("bash", { command })).toBeUndefined();
      expect(h.asks).toEqual([]);
      expect(h.entries[0]?.stages[0]?.outcome).toBe("pass");
    },
  );

  it.each(friction.map((entry) => [entry.command.slice(0, 60), entry] as const))(
    "known friction, pinned: %s",
    async (_name, entry) => {
      const h = bed.harness({ answers: [{ answer: "session", closed: false }] });
      await h.run("bash", { command: entry.command });
      const { stage01, reason } = entry.knownFriction ?? { stage01: "pass", reason: "no friction pinned" };
      expect(h.entries[0]?.stages[0]).toEqual({ stage: "01", outcome: stage01, reason });
    },
  );
});

describe("daily use: the built-in tools run without a question in auto-accept-edits", () => {
  const calls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["read", { path: "src/index.ts" }],
    ["write", { path: "src/new.ts", content: "export {};\n" }],
    ["edit", { path: "src/index.ts", edits: [{ oldText: "a", newText: "b" }] }],
    ["grep", { pattern: "TODO", path: "src" }],
    ["find", { pattern: "*.ts", path: "src" }],
    ["ls", { path: "src" }],
  ];
  it.each(calls)("%s", async (tool, input) => {
    const h = bed.harness();
    expect(await h.run(tool, input)).toBeUndefined();
    expect(h.asks).toEqual([]);
    expect(h.entries[0]).toMatchObject({ decision: "allow" });
  });
});
