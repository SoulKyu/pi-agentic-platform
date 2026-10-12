import { type PolicyAuditEntry, type PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { BUILTIN_CHECKS, DENYLIST_MODEL_REASON } from "./denylist.ts";
import { grantKey, grantPayload } from "./grant-key.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const full =
  (extra: Partial<PolicyRules> = {}) =>
  () => ({ ...interactiveRules, ...extra });
const stage01 = (h: { entries: readonly PolicyAuditEntry[] }) => {
  const entry = h.entries.at(-1);
  return entry?.kind === "call" ? entry.stages[0] : undefined;
};
const BLOCKED = { block: true, reason: DENYLIST_MODEL_REASON };

describe("the built-in preset", () => {
  it.each([
    "rm -rf /",
    "rm -fr /*",
    "rm -r -f ~",
    "rm --recursive --force $HOME",
    'rm -rf "${HOME}/"',
    "sudo rm -rf --no-preserve-root /",
    "chmod -R 777 /",
    "chown -R nobody /",
    "mkfs.ext4 /dev/sda1",
    "mkswap /dev/nvme0n1p2",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "shred -n 1 /dev/sdb",
    "echo x > /dev/sda",
    "cat img >>/dev/mmcblk0",
    ":(){ :|:& };:",
    "bomb(){ bomb|bomb& };bomb",
    "ls; rm -rf /",
    "bash -c 'rm -rf ~'",
    "echo $(rm -rf /)",
    "\\rm -rf //",
    "/bin/rm -Rf /.",
  ])("blocks %j, whatever stage 03 would say", async (command) => {
    const h = bed.harness({ rules: full(), stages: ALLOW_03 });
    expect(await h.run("bash", { command })).toEqual(BLOCKED);
    expect(h.entries.at(-1)).toMatchObject({
      decision: "block",
      stages: [
        { stage: "01", outcome: "block" },
        { stage: "02", outcome: "skip" },
        { stage: "03", outcome: "skip" },
        { stage: "04", outcome: "skip" },
      ],
    });
  });

  it.each([
    "rm -rf ./build",
    "rm -rf ~/project/tmp",
    "rm -r /tmp/x",
    "chmod -R 755 ./dist",
    "dd if=/dev/zero of=./disk.img",
    "echo / ~",
    "echo rm -rf /",
  ])("lets %j through", async (command) => {
    const h = bed.harness({ rules: full(), stages: ALLOW_03 });
    expect(await h.run("bash", { command })).toBeUndefined();
    expect(stage01(h)).toEqual({ stage: "01", outcome: "pass", reason: "1 command checked" });
  });

  it("names the check in the audit and never the command", async () => {
    const h = bed.harness({ rules: full(), stages: ALLOW_03 });
    await h.run("bash", { command: "echo s3cret-token; rm -rf /" });
    const entry = h.entries.at(-1);
    expect(entry?.kind === "call" && entry.stages[0]).toEqual({
      stage: "01",
      outcome: "block",
      reason: "denied: rm-root",
    });
  });

  it("has the stable ids of the preset", () => {
    expect(BUILTIN_CHECKS.map((check) => check.id)).toEqual([
      "rm-root",
      "chmod-root",
      "mkfs",
      "dd-device",
      "wipe-device",
      "redirect-device",
    ]);
  });

  it("is turned off by the owner, and a grant or an answer never lets a denied command through", async () => {
    const off = bed.harness({ rules: full({ builtinDenylist: false }), stages: ALLOW_03 });
    expect(await off.run("bash", { command: "rm -rf /" })).toBeUndefined();
    const key = grantKey("bash", grantPayload({ command: "rm -rf /" }, true));
    const granted = bed.harness({
      rules: () => ({ ...interactiveRules, alwaysAllow: [{ tool: "bash", key }] }),
    });
    expect(await granted.run("bash", { command: "rm -rf /" })).toEqual(BLOCKED);
    expect(granted.asks).toEqual([]);
  });

  it("checks an extension or MCP tool's string command field (M5R117) and skips a built-in tool that is not a shell", async () => {
    const tools = {
      run_shell: { path: "/ext/x.js" },
      mcp__shell__exec: { path: "builtin:mcp" },
      read: { path: "builtin:read" },
    };
    const h = bed.harness({ rules: full({ approvalMode: "full-access" }), tools, stages: ALLOW_03 });
    expect(await h.run("run_shell", { command: "rm -rf ~" })).toEqual(BLOCKED);
    expect(await h.run("mcp__shell__exec", { command: "rm -rf /" })).toEqual(BLOCKED);
    expect(await h.run("read", { path: "a", command: "rm -rf /" })).toBeUndefined();
    expect(h.entries.at(-1)).toMatchObject({
      stages: [
        { stage: "01", outcome: "skip", reason: "not a command" },
        { stage: "02", outcome: "skip" },
        { stage: "03", outcome: "allow" },
        { stage: "04", outcome: "pass" },
      ],
    });
  });

  it("does not take an extension named powershell for PowerShell", async () => {
    const h = bed.harness({ rules: full(), tools: { powershell: { path: "/ext/ps.js" } }, stages: ALLOW_03 });
    expect(await h.run("powershell", { command: "rm -rf /" })).toEqual(BLOCKED);
  });
});

describe("the owner's patterns", () => {
  it("block on the segment as written or without its wrappers", async () => {
    const h = bed.harness({
      rules: full({ denylist: ["git push --force*", "sudo *", "terraform destroy*"] }),
      stages: ALLOW_03,
    });
    for (const command of [
      "git push --force-with-lease origin main",
      "ls && sudo apt update",
      "cd x; terraform  destroy -auto-approve",
    ])
      expect(await h.run("bash", { command })).toEqual(BLOCKED);
    expect(await h.run("bash", { command: "git push origin main" })).toBeUndefined();
  });

  it("block a command whose pattern only fits once the wrappers are gone", async () => {
    const h = bed.harness({ rules: full({ denylist: ["terraform destroy*"] }), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "sudo -u root env X=1 terraform destroy" })).toEqual(BLOCKED);
  });

  it("block the harmless test command and name the pattern in the audit", async () => {
    const h = bed.harness({ rules: full({ denylist: ["pap-test-blocked *"] }), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "pap-test-blocked now" })).toEqual(BLOCKED);
    const entry = h.entries.at(-1);
    expect(entry?.kind === "call" && entry.stages[0]?.reason).toBe("denied: pap-test-blocked *");
  });

  it("clip the pattern named in the audit to 100 characters", async () => {
    const pattern = `${"x".repeat(150)}*`;
    const h = bed.harness({ rules: full({ denylist: [pattern] }), stages: ALLOW_03 });
    await h.run("bash", { command: "x".repeat(151) });
    const entry = h.entries.at(-1);
    expect(entry?.kind === "call" && entry.stages[0]?.reason).toBe(`denied: ${"x".repeat(100)}`);
  });

  it("match PowerShell commands without case and leave the bash preset out of PowerShell", async () => {
    const h = bed.harness({ rules: full({ denylist: ["remove-item -recurse*"] }), stages: ALLOW_03 });
    expect(await h.run("powershell", { command: "Remove-Item -Recurse C:\\" })).toEqual(BLOCKED);
    expect(await h.run("powershell", { command: "rm -rf /" })).toBeUndefined();
  });

  it("stay case-sensitive for bash", async () => {
    const h = bed.harness({ rules: full({ denylist: ["Remove-Item*"] }), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "remove-item x" })).toBeUndefined();
  });

  it("see a lookalike blank in the pattern or in the command as the space it looks like", async () => {
    const h = bed.harness({
      rules: full({ denylist: ["pap-test-blocked\u00A0now*", "pap-test-other\u3000run*"] }),
      stages: ALLOW_03,
    });
    expect(await h.run("bash", { command: "pap-test-blocked now" })).toEqual(BLOCKED);
    expect(await h.run("bash", { command: "pap-test-other run" })).toEqual(BLOCKED);
    const plain = bed.harness({ rules: full({ denylist: ["pap-test-blocked now*"] }), stages: ALLOW_03 });
    expect(await plain.run("bash", { command: "pap-test-blocked\u00A0now" })).toEqual(BLOCKED);
    expect(await plain.run("bash", { command: "pap-test-blocked\u2003now" })).toEqual(BLOCKED);
  });

  it("see two spaces in the pattern as the one space the command's words are joined by", async () => {
    const h = bed.harness({ rules: full({ denylist: ["terraform  destroy*"] }), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "terraform destroy" })).toEqual(BLOCKED);
  });

  it("match a pattern and a command that both hold the same lone surrogate", async () => {
    const h = bed.harness({ rules: full({ denylist: ["pap-test-blocked \uD800*"] }), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "pap-test-blocked \uD800 now" })).toEqual(BLOCKED);
    expect(await h.run("bash", { command: "pap-test-blocked now" })).toBeUndefined();
  });
});
