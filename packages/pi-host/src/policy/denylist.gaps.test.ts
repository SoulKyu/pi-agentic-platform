import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { denylistStage } from "./denylist.ts";
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
const blocked = (id: string) => ({ outcome: "block", reason: `denied: ${id}` });

describe("a reading that is unsure still runs the rough built-in scan (M3)", () => {
  it.each([
    [`echo "\${x//'"'/}"; rm -rf /`, "rm-root"],
    [`echo "\${x//'"'/}"\nmkfs.ext4 /dev/sda1`, "mkfs"],
    [`echo "\${y:-'"'}" && dd if=/dev/zero of=/dev/sda`, "dd-device"],
  ])("blocks %s", (command, id) => {
    expect(stage01(command)).toMatchObject(blocked(id));
  });

  it("does not add a question for an unsure reading that holds no built-in hit", () => {
    expect(stage01(`echo "\${x//'"'/}"; ls -la`)).toMatchObject({ outcome: "pass" });
  });
});

describe("wrappers, command-string programs and devices the reader now knows (M3)", () => {
  it.each([
    ["builtin command rm -rf /", "rm-root"],
    ["builtin rm -rf /", "rm-root"],
    ["sg docker -c 'rm -rf /'", "rm-root"],
    ["sg docker -c 'mkfs.ext4 /dev/sda1'", "mkfs"],
    ["dd if=/dev/zero of=/dev/root", "dd-device"],
    ["echo x > /dev/root", "redirect-device"],
    ["shred /dev/root", "wipe-device"],
  ])("blocks %s", (command, id) => {
    expect(stage01(command)).toMatchObject(blocked(id));
  });

  it.each([
    "builtin echo hi",
    "sg docker -c 'ls /tmp'",
    "dd if=/dev/zero of=/tmp/rootfs",
    "ls /dev/root-notes",
  ])("passes %s", (command) => {
    expect(stage01(command)).toMatchObject({ outcome: "pass" });
  });

  it.each(["pkexec rm -rf /", "chrt -f 99 rm -rf /", "systemd-run --user rm -rf /", 'rm -rf "$DIR"/*'])(
    "documented pass: %s",
    (command) => {
      expect(stage01(command)).toMatchObject({ outcome: "pass" });
    },
  );
});
