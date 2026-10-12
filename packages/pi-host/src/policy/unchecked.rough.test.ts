import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { DENYLIST_MODEL_REASON, roughBuiltinHit } from "./denylist.ts";
import { type StepBudget } from "./glob.ts";
import { CommandTooComplex } from "./shell-words.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const PAD = "true;".repeat(1001);
const BLOCKED = { block: true, reason: DENYLIST_MODEL_REASON };
const TOO_COMPLEX = "command too complex for the policy check";

describe("the rough scan follows the reader's own forms", () => {
  const forms: readonly string[] = [
    "/bin/rm -rf ~",
    "/usr/sbin/mkfs.ext4 /dev/sda",
    "rm -rf ${HOME}",
    "rm -rf \\\n~",
    "rm \\\n-rf \\\n/",
    "echo x>/dev/sda",
    "cat /dev/zero >/dev/sda",
    "rm${IFS}-rf${IFS}~",
    "rm$IFS-rf$IFS~",
    "echo x >|/dev/sda",
    "echo x >| /dev/sda",
    "echo x >&/dev/sda",
    "echo x &>/dev/sda",
  ];
  it.each(forms)("blocks %j after 1001 commands", async (form) => {
    const h = bed.harness();
    expect(await h.run("bash", { command: `${PAD}${form}` })).toEqual(BLOCKED);
    expect(h.asks).toEqual([]);
  });

  it.each([
    'rm -rf "${BUILD_DIR}/"',
    "rm -rf ${dir:?}/*",
    "rm -rf ${a} ${b:-x}/y",
    "cmd 2>&1 | tail",
    "cmd >&2",
    "cat <&3",
  ])("asks about %j after 1001 commands: braces of an expansion stay whole", async (form) => {
    const h = bed.harness();
    expect(await h.run("bash", { command: `${PAD}${form}` })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
  });
});

describe("the rough scan has a step budget (RT-16)", () => {
  const spent = (command: string): number => {
    const budget: StepBudget = { left: 4_000_000 };
    expect(roughBuiltinHit(command, budget)).toBeNull();
    return 4_000_000 - budget.left;
  };

  it("spends a pinned number of steps", () => {
    expect(spent("true;".repeat(1001))).toBe(1627);
    expect(spent("echo hi")).toBe(2);
    expect(spent("rm -r ".repeat(10))).toBe(148);
  });

  it("blocks with the reader's reason when the budget runs out", async () => {
    const command = "rm -r ".repeat(340_000);
    expect(() => roughBuiltinHit(command, { left: 4_000_000 })).toThrow(CommandTooComplex);
    const h = bed.harness();
    expect(await h.run("bash", { command })).toEqual({ block: true, reason: TOO_COMPLEX });
    expect(h.asks).toEqual([]);
  });

  it("throws on an input over the size cap (the pipeline's own 2 MiB limit comes first)", () => {
    expect(() => roughBuiltinHit("a".repeat(4 * 1024 * 1024 + 1))).toThrow(CommandTooComplex);
  });
});
