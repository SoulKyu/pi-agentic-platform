import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { BASH_CORPUS } from "./daily-use.corpus.ts";
import { DENYLIST_MODEL_REASON } from "./denylist.ts";
import { guardTitle } from "./run-guard.ts";
import { UNCHECKED_REASON } from "./unchecked.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const UNREADABLE = "true;".repeat(1001);
const trip = { outcome: "trip", rule: "tool-calls", reason: "150 calls in this run" } as const;
const BLOCKED = { block: true, reason: DENYLIST_MODEL_REASON };

describe("padding does not turn a catastrophic command into a question", () => {
  const probes: ReadonlyArray<readonly [string, string]> = [
    ["1001 commands, then rm -rf ~", `${UNREADABLE} rm -rf ~`],
    ["1001 newlines, then rm -rf ~", `${"\n".repeat(1001)}rm -rf ~`],
    ["rm -rf / before 1000 empty commands", `rm -rf / ;${":;".repeat(1000)}`],
    [
      "four levels of bash -c around rm -rf ~",
      `bash -c "bash -c 'bash -c \\"bash -c \\\\\\"rm -rf ~\\\\\\"\\"'"`,
    ],
    ["rm -rf ~ after 70 000 blanks", `${" ".repeat(70_000)}rm -rf ~`],
    ["a quoted rm -rf / after 1001 commands", `${UNREADABLE} "rm" '-rf' "/"`],
    ["mkfs after 1001 commands", `${UNREADABLE} mkfs.ext4 /dev/sda1`],
    ["a write to a disk after 1001 commands", `${UNREADABLE} dd if=/dev/zero of=/dev/sda`],
  ];
  it.each(probes)("blocks %s in auto-accept-edits with a UI", async (_name, command) => {
    const h = bed.harness();
    expect(await h.run("bash", { command })).toEqual(BLOCKED);
    expect(h.asks).toEqual([]);
  });

  it("still asks about a harmless command of the same size", async () => {
    const h = bed.harness();
    expect(await h.run("bash", { command: `${UNREADABLE} rm -rf ./build` })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
  });

  it("leaves the here-documents of the corpus as they are", async () => {
    const heredocs = BASH_CORPUS.filter(({ command }) => /^(?:python3 - <<|psql )/.test(command));
    expect(heredocs).toHaveLength(2);
    for (const { command } of heredocs) {
      const h = bed.harness();
      expect(await h.run("bash", { command })).toBeUndefined();
      expect(h.entries[0]?.stages[0]?.outcome).toBe("pass");
      expect(h.asks[0]?.answers).toHaveLength(4);
    }
  });
});

describe("what the person sees", () => {
  it("puts the unchecked reason in the title of the card", async () => {
    const h = bed.harness();
    await h.run("bash", { command: UNREADABLE });
    expect(h.asks[0]?.title).toBe(UNCHECKED_REASON);
    expect(h.asks[0]?.message.split("\n").at(-1)).toMatch(/^bash: true;/);
  });

  it("puts it on the first line of the message when the guard owns the title, in one question", async () => {
    const h = bed.harness({ stages: { guard: () => trip } });
    await h.run("bash", { command: UNREADABLE });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ answers: ["deny", "once"], guard: "tool-calls" });
    expect(h.asks[0]?.title).toBe(guardTitle("tool-calls", interactiveRules.guard));
    expect(h.asks[0]?.message.split("\n")[0]).toBe(`${UNCHECKED_REASON} 5005 characters, 1 line`);
  });

  it("leaves the card of a command that was checked alone", async () => {
    const h = bed.harness();
    await h.run("bash", { command: "ls" });
    expect(h.asks[0]?.title).toBe("Run a command?");
    expect(h.asks[0]?.message).not.toContain(UNCHECKED_REASON);
  });
});

describe("the other stages", () => {
  it("blocks an answered call when the rules made its command unreadable while the question was open", async () => {
    let version = 0;
    const h = bed.harness({
      rulesVersion: () => version,
      ask: async () => {
        version++;
        return { answer: "once", closed: false };
      },
      stages: {
        denylist: () =>
          version === 0
            ? { outcome: "pass", reason: "1 command checked" }
            : { outcome: "unchecked", reason: "command too complex for the policy check", modelReason: "m" },
      },
    });
    expect(await h.run("bash", { command: "make" })).toEqual({ block: true, reason: "m" });
    expect(h.entries.at(-1)).toMatchObject({
      decision: "block",
      reason: "policy changed while the question was open: command too complex for the policy check",
    });
  });

  it("names the real cause when the egress stage cannot read the command", async () => {
    const h = bed.harness({ rules: () => ({ ...interactiveRules, allowHosts: ["example.com"] }) });
    expect(await h.run("bash", { command: UNREADABLE })).toEqual({
      block: true,
      reason: "input too complex for the egress check",
    });
    expect(h.asks).toEqual([]);
  });
});
