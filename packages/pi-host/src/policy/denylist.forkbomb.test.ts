import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { denylistStage, isForkBomb } from "./denylist.ts";
import type { CallFacts } from "./pipeline.ts";
import { classifyTool } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const stage01 = (command: string) => {
  const kind = classifyTool("bash", { path: "builtin:bash" });
  const call: CallFacts = {
    event: { toolCallId: "c1", toolName: "bash", input: { command } },
    kind,
    rules: { ...interactiveRules },
    cwd: bed.cwd,
    tainted: false,
    key: "k",
    exec: true,
  };
  return denylistStage(call);
};

describe("fork-bomb names bash accepts (M2 of the M5 final review)", () => {
  it.each([
    ":(){ :|:& };:",
    "f(){ f|f& };f",
    ".(){ .|.& };.",
    "a.b(){ a.b|a.b& };a.b",
    "a-b(){ a-b|a-b& };a-b",
    "a@b(){ a@b|a@b& };a@b",
    "x(){ x | x & }; x",
    "function a.b { a.b|a.b& }; a.b",
    "function a-b { a-b|a-b& }; a-b",
  ])("blocks %s", (command) => {
    expect(isForkBomb(command)).toBe(true);
  });

  it.each([
    "f(){ f|g& };f",
    "f(){ echo hi; }; f",
    "a.b(){ a.b|cat; }; a.b",
    "echo a.b | a.b &",
    "function a.b { echo; }",
  ])("leaves %s alone", (command) => {
    expect(isForkBomb(command)).toBe(false);
  });
});

describe("the unreadable path tests the size bound before the fork-bomb scan", () => {
  const OVER = 4 * 1024 * 1024 + 1;
  it("answers the size limit, not a scan, for an input past the rough scan's cap", () => {
    const verdict = stage01(`:(){ :|:& };:${" ".repeat(OVER)}`);
    expect(verdict).toMatchObject({
      outcome: "block",
      reason: "command too complex for the policy check",
    });
  });

  it("still names a fork bomb inside the cap", () => {
    expect(stage01(`:(){ :|:& };:${" ".repeat(300_000)}`)).toMatchObject({
      outcome: "block",
      reason: "denied: fork-bomb",
    });
  });
});
