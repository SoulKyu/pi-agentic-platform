import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { DENYLIST_MODEL_REASON, matchOwnerPatterns } from "./denylist.ts";
import { CALL_BUDGET, type StepBudget } from "./glob.ts";
import { CommandTooComplex, readCommands } from "./shell-words.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const TOO_COMPLEX = "command too complex for the policy check";
const TOO_LONG = "command too long for the policy check";
const BLOCKED = { block: true, reason: DENYLIST_MODEL_REASON };
const rules =
  (denylist: string[] = []) =>
  () => ({ ...interactiveRules, denylist });
const letterRun = `*${"a".repeat(64)}b`;
const adversarial: ReadonlyArray<readonly [string, string]> = [
  ["a run of recursive flags", "rm " + "-r ".repeat(21_000)],
  ["a run of fork-bomb openers", ":(){ ".repeat(13_000)],
  ["a long name before a function body", "x".repeat(65_530) + "(){ "],
  ["a run of slashes as the operand", "rm -rf " + "/".repeat(65_528)],
  ["32768 words", "a ".repeat(32_768)],
  ["20000 substitution openers", "$(".repeat(20_000)],
  ["a run of backslashes", "\\".repeat(65_536)],
  ["a run of single quotes", "'".repeat(65_535)],
  ["a run of letters", "a".repeat(65_530)],
];

describe("bounded work", () => {
  it.each(adversarial)(
    "ends in a block or a pass for %s, never in a throw",
    async (_name, command) => {
      const h = bed.harness({ rules: rules(Array.from({ length: 64 }, () => letterRun)), stages: ALLOW_03 });
      const result = await h.run("bash", { command });
      expect(result === undefined || result.block === true).toBe(true);
      expect(h.entries).toHaveLength(1);
      // Safety net only (RT-16): the work itself is pinned by step counts below.
    },
    1500,
  );

  it("blocks the letter run as too complex under 64 patterns", async () => {
    const h = bed.harness({ rules: rules(Array.from({ length: 64 }, () => letterRun)), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "a".repeat(65_530) })).toEqual({
      block: true,
      reason: TOO_COMPLEX,
    });
  }, 10_000);

  it("spends exactly one pair budget on a pattern that exhausts it", () => {
    const total: StepBudget = { left: CALL_BUDGET };
    expect(() => matchOwnerPatterns(readCommands("a".repeat(65_530)), [letterRun], false, total)).toThrow(
      CommandTooComplex,
    );
    expect(total.left).toBe(18_000_000);
  });

  it("lets a 30 KiB legitimate command through ten star-led patterns, spending 30 726 steps each", () => {
    const patterns = Array.from({ length: 10 }, (_v, n) => `*--force${n}*`);
    const total: StepBudget = { left: CALL_BUDGET };
    expect(matchOwnerPatterns(readCommands("echo " + "x".repeat(30_720)), patterns, false, total)).toBeNull();
    expect(CALL_BUDGET - total.left).toBe(307_260);
  });

  it("spends no glob step on a pair whose form does not start with the literal prefix", () => {
    const total: StepBudget = { left: CALL_BUDGET };
    matchOwnerPatterns(readCommands("echo hello"), ["git push*", "sudo *", "equal"], false, total);
    expect(total.left).toBe(CALL_BUDGET);
  });
});

describe("blanks", () => {
  it.each(["rm\t-rf\t/", "rm  -rf   /"])("blocks %j", async (command) => {
    const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
    expect(await h.run("bash", { command })).toEqual(BLOCKED);
  });

  it.each(["rm -rf /", "rm　-rf /"])(
    "does not block %j: bash does not split on it, so the command word is one that does not exist",
    async (command) => {
      const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
      expect(await h.run("bash", { command })).toBeUndefined();
    },
  );
});

describe("control and format characters", () => {
  it("never throws on any of them", async () => {
    const h = bed.harness({ rules: rules(["pap-test-blocked *"]), stages: ALLOW_03 });
    for (let code = 0; code < 0x20; code++)
      await h.run("bash", { command: `echo ${String.fromCharCode(code)}x; rm -rf ./y` });
    for (const char of ["\u0085", "​", " ", " ", "﻿", "\uD800", "\uDFFF"])
      await h.run("bash", { command: `echo ${char}x` });
    expect(h.entries).toHaveLength(32 + 7);
  });

  it("blocks a bidi override after the operand: the root is a word of its own", async () => {
    const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "rm -rf / ‮" })).toEqual(BLOCKED);
  });

  it("documented pass: a NUL inside the operand makes it a path that is not the root", async () => {
    const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "rm -rf /\u0000x" })).toBeUndefined();
  });

  it("documented pass: a zero-width joiner makes the command word another command, as in bash", async () => {
    const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "r‍m -rf /" })).toBeUndefined();
  });
});

describe("unclosed quotes and substitutions", () => {
  it.each(['rm -rf "/', "echo $(rm -rf /", "echo `rm -rf /", "bash -c 'rm -rf /"])(
    "reads %j to the end and blocks it",
    async (command) => {
      const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
      expect(await h.run("bash", { command })).toEqual(BLOCKED);
    },
  );

  it("reads a substitution inside single quotes as text", async () => {
    const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "echo '$(rm -rf /)" })).toBeUndefined();
  });
});

describe("nesting and size", () => {
  it("blocks four levels of bash -c as too complex", async () => {
    const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
    const command = `bash -c "bash -c 'bash -c \\"bash -c ls\\"'"`;
    expect(await h.run("bash", { command })).toEqual({ block: true, reason: TOO_COMPLEX });
  });

  it("blocks 1001 commands as too complex", async () => {
    const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "true;".repeat(1001) })).toEqual({
      block: true,
      reason: TOO_COMPLEX,
    });
  });

  it("blocks a 65 537-character command as too long, and keeps the command out of the audit", async () => {
    const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "zz".repeat(32_768) + "z" })).toEqual({
      block: true,
      reason: TOO_LONG,
    });
    expect(JSON.stringify(h.entries.at(-1)?.kind === "call" && h.entries.at(-1)?.stages)).not.toContain(
      "zzzz",
    );
  });
});

describe("a command that is not a string", () => {
  it.each([["rm", "-rf", "/"], null, 42, { a: 1 }, undefined])(
    "is skipped as not a command: %j",
    async (command) => {
      const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
      expect(await h.run("bash", { command })).toBeUndefined();
      const entry = h.entries.at(-1);
      expect(entry?.kind === "call" && entry.stages[0]).toEqual({
        stage: "01",
        outcome: "skip",
        reason: "not a command",
      });
    },
  );

  it("skips an input that is not an object", async () => {
    const h = bed.harness({ rules: rules(), stages: ALLOW_03 });
    expect(await h.run("bash", "rm -rf /")).toBeUndefined();
    expect(await h.run("bash", null)).toBeUndefined();
  });
});
