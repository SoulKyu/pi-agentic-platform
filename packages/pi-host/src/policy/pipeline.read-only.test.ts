import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { CLEAN, handRepo, SAFE_SHELL } from "./cover-bed.ts";
import { READ_ONLY_REASON } from "./reasons.ts";
import { READ_ONLY_COMMAND_MODES, READ_ONLY_COMMAND_REASON } from "./stage-approval.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
  for (const name of ["README.md", "secret.txt"]) writeFileSync(join(bed.cwd, name), "x\n");
  writeFileSync(join(bed.agentDir, "auth.json"), "{}");
  handRepo(bed.cwd, CLEAN);
});
afterAll(() => bed.dispose());

const mode =
  (approvalMode: PolicyRules["approvalMode"], patch: Partial<PolicyRules> = {}) =>
  () =>
    PolicyRules.parse({ ...interactiveRules, approvalMode, ...patch });
const CAT = { command: "cat README.md" };

describe("stage 03: read-only commands", () => {
  it.each(["auto-accept-edits", "supervised"] as const)(
    "runs a read-only command without a question in %s",
    async (approvalMode) => {
      const h = bed.harness({ rules: mode(approvalMode), shell: SAFE_SHELL });
      expect(await h.run("bash", CAT)).toBeUndefined();
      expect(h.asks).toEqual([]);
      expect(h.entries[0]).toMatchObject({
        decision: "allow",
        reason: "read-only command",
        category: "exec",
      });
      expect(h.entries[0]?.stages[2]).toMatchObject({ stage: "03", outcome: "allow" });
    },
  );

  it("pins the modes and the reason", () => {
    expect([...READ_ONLY_COMMAND_MODES].sort()).toEqual(["auto-accept-edits", "supervised"]);
    expect(READ_ONLY_COMMAND_REASON).toBe("read-only command");
  });

  it("blocks it in read-only mode and allows it in full access as before", async () => {
    const ro = bed.harness({ rules: mode("read-only"), shell: SAFE_SHELL });
    expect(await ro.run("bash", CAT)).toEqual({ block: true, reason: READ_ONLY_REASON });
    const full = bed.harness({ rules: mode("full-access"), shell: SAFE_SHELL });
    expect(await full.run("bash", CAT)).toBeUndefined();
    expect(full.entries[0]).toMatchObject({ decision: "allow", reason: "exec allowed" });
  });

  it("asks when the settings switch is off", async () => {
    const h = bed.harness({
      rules: mode("auto-accept-edits", { readOnlyCommands: false }),
      shell: SAFE_SHELL,
    });
    expect(await h.run("bash", CAT)).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect([...(h.asks[0]?.answers ?? [])].sort()).toEqual(["always", "deny", "once", "session"]);
  });

  it("a tainted session runs a read-only command and still asks for curl", async () => {
    const h = bed.harness({ taint: true, shell: SAFE_SHELL });
    expect(await h.run("bash", CAT)).toBeUndefined();
    expect(h.asks).toEqual([]);
    expect(h.entries[0]).toMatchObject({ decision: "allow", reason: "read-only command" });
    expect(await h.run("bash", { command: "curl https://example.com" }, "c2")).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ answers: ["deny", "once"], tainted: true });
  });

  it("the denylist wins", async () => {
    const h = bed.harness({
      rules: mode("auto-accept-edits", { denylist: ["cat *secret*"] }),
      shell: SAFE_SHELL,
    });
    const result = await h.run("bash", { command: "cat secret.txt" });
    expect(result).toMatchObject({ block: true });
    expect(h.entries[0]?.stages[0]).toMatchObject({
      stage: "01",
      outcome: "block",
      reason: "denied: cat *secret*",
    });
  });

  it("the run guard still trips", async () => {
    const h = bed.harness({ shell: SAFE_SHELL, answers: [{ answer: "once", closed: false }] });
    h.runStart();
    const status = { command: "git status" };
    for (let at = 1; at <= 4; at++) expect(await h.run("bash", status, `c${at}`)).toBeUndefined();
    expect(h.asks).toEqual([]);
    expect(await h.run("bash", status, "c5")).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ guard: "identical-calls" });
  });

  it("a protected path asks the ordinary way", async () => {
    const h = bed.harness({ shell: SAFE_SHELL });
    expect(await h.run("bash", { command: "cat ~/agent/auth.json" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect([...(h.asks[0]?.answers ?? [])].sort()).toEqual(["always", "deny", "once", "session"]);
    expect(h.entries[0]).not.toMatchObject({ reason: "read-only command" });
  });

  it("a shell command prefix turns it off", async () => {
    const h = bed.harness({ shell: { ...SAFE_SHELL, commandPrefix: "source ~/.bash_aliases" } });
    await h.run("bash", CAT);
    expect(h.asks).toHaveLength(1);
  });

  it("a config without shell facts covers nothing", async () => {
    const h = bed.harness();
    await h.run("bash", CAT);
    expect(h.asks).toHaveLength(1);
  });

  it("only Pi's own bash", async () => {
    const h = bed.harness({ shell: SAFE_SHELL, tools: { bash: { path: "/ext/x.ts" } } });
    await h.run("bash", CAT);
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ category: "unknown" });
  });

  it("ripgrep asks when its config variable is set, and runs when it is not (MC16)", async () => {
    const rg = { command: "rg -n TODO src" };
    const plain = bed.harness({ shell: SAFE_SHELL });
    expect(await plain.run("bash", rg)).toBeUndefined();
    expect(plain.asks).toEqual([]);
    const configured = bed.harness({ shell: { ...SAFE_SHELL, rgConfig: true } });
    await configured.run("bash", rg);
    expect(configured.asks).toHaveLength(1);
    const other = bed.harness({ shell: { ...SAFE_SHELL, rgConfig: true } });
    await other.run("bash", CAT);
    expect(other.asks).toEqual([]);
  });

  it("a repository whose config runs a program asks for git status", async () => {
    const git = join(bed.cwd, ".git");
    const status = { command: "git status" };
    const clean = bed.harness({ shell: SAFE_SHELL });
    expect(await clean.run("bash", status)).toBeUndefined();
    expect(clean.asks).toEqual([]);
    const env = bed.harness({ shell: { ...SAFE_SHELL, gitEnv: true } });
    await env.run("bash", status);
    expect(env.asks).toHaveLength(1);
    writeFileSync(join(git, "config"), "[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ./hook.sh\n");
    const dirty = bed.harness({ shell: SAFE_SHELL });
    await dirty.run("bash", status);
    expect(dirty.asks).toHaveLength(1);
    expect([...(dirty.asks[0]?.answers ?? [])].sort()).toEqual(["always", "deny", "once", "session"]);
    expect(dirty.entries[0]).not.toMatchObject({ reason: "read-only command" });
    writeFileSync(join(git, "config"), CLEAN);
  });

  it("a tainted session asks for git and still runs the other covered commands (MC17)", async () => {
    const h = bed.harness({ taint: true, shell: SAFE_SHELL });
    expect(await h.run("bash", { command: "git status" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ tainted: true, answers: ["deny", "once"] });
    expect(h.entries[0]).not.toMatchObject({ reason: "read-only command" });
    expect(await h.run("bash", { command: "cat README.md | wc -l" }, "c2")).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.entries[1]).toMatchObject({ decision: "allow", reason: "read-only command" });
  });

  it("asks for git when no repository exists at evaluation time (MC17)", async () => {
    const h = bed.harness({ shell: SAFE_SHELL });
    expect(await h.run("bash", { command: "git -C ../outside status" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect([...(h.asks[0]?.answers ?? [])].sort()).toEqual(["always", "deny", "once", "session"]);
    expect(h.entries[0]).not.toMatchObject({ reason: "read-only command" });
  });

  it("evaluates again when the rules version moved during the check", async () => {
    let version = 0;
    let reads = 0;
    const h = bed.harness({
      shell: SAFE_SHELL,
      rulesVersion: () => version,
      rules: () => {
        reads++;
        if (reads === 1) version++;
        return interactiveRules;
      },
    });
    expect(await h.run("bash", CAT)).toBeUndefined();
    expect(reads).toBe(2);
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({ decision: "allow", reason: "read-only command" });
  });
});
