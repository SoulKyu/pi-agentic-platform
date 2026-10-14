import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bashScript, createHostBed, isApproval, isCallAudit, toolText } from "./testing/host-bed.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

// The default rules, read-only commands on (the shared bed switches them off).
const ON = PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits" });
const within = { timeout: 20_000 };
// pnpm puts a relative `./node_modules/.bin` in PATH, and a relative PATH entry is never covered: the worker gets absolute ones.
const PATH = (process.env.PATH ?? "")
  .split(":")
  .filter((entry) => entry.startsWith("/"))
  .join(":");
const twoCalls = (first: string, second: string) => ({
  steps: [
    { toolCalls: [{ name: "bash", args: { command: first }, id: "call-1" }] },
    { toolCalls: [{ name: "bash", args: { command: second }, id: "call-2" }] },
    { text: "done" },
  ],
});

/** A repository made by hand, as the policy reads it: no git run builds it. */
function handRepo(config: string): void {
  const git = join(bed.cwd, ".git");
  mkdirSync(join(git, "objects"), { recursive: true });
  mkdirSync(join(git, "refs"), { recursive: true });
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(git, "config"), config);
}
const CLEAN = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";

describe("pi-host worker: read-only commands", () => {
  it("runs ls unasked and asks for a protected file", async () => {
    writeFileSync(join(bed.agentDir, "auth.json"), "{}");
    writeFileSync(join(bed.cwd, "marker.txt"), "x\n");
    await bed.start(twoCalls("ls", `cat ${join(bed.agentDir, "auth.json")}`), { env: { PATH }, policy: ON });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(ask).toMatchObject({ category: "exec", tool: "bash" });
    const first = host.records.find((r) => r.type === "tool_execution_end");
    expect(first?.isError).toBe(false);
    expect(toolText(first as never)).toContain("marker.txt");
    expect(host.records.filter(isApproval)).toHaveLength(1);
    host.send({ type: "approval_response", id: ask.id, answer: "deny" });
    await vi.waitFor(() => expect(host.records.filter(isCallAudit)).toHaveLength(2), within);
    expect(host.records.filter(isCallAudit)[0]).toMatchObject({
      entry: { decision: "allow", reason: "read-only command", category: "exec" },
    });
  });

  it("asks for ls when the Pi settings give a shell command prefix", async () => {
    await bed.start(bashScript("ls"), {
      settings: { shellCommandPrefix: "true" },
      env: { PATH },
      policy: ON,
    });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(ask).toMatchObject({ category: "exec", tool: "bash" });
  });

  it("asks for git status when the repository config runs a program, and git never runs when denied", async () => {
    const marker = join(bed.cwd, "ran.marker");
    const hook = join(bed.cwd, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    handRepo(`${CLEAN}\tfsmonitor = ${hook}\n`);
    await bed.start(bashScript("git status"), { env: { PATH }, policy: ON });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(ask).toMatchObject({ category: "exec", tool: "bash" });
    host.send({ type: "approval_response", id: ask.id, answer: "deny" });
    await vi.waitFor(() => expect(host.records.filter(isCallAudit)).toHaveLength(1), within);
    expect(host.records.filter(isCallAudit)[0]).toMatchObject({ entry: { decision: "denied" } });
    expect(existsSync(marker)).toBe(false);
  });

  it("runs git status unasked in a repository with a clean config and shows its output", async () => {
    handRepo(CLEAN);
    await bed.start(bashScript("git status"), { env: { PATH }, policy: ON });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(host.records.filter(isApproval)).toEqual([]);
    expect(toolText(end)).toContain("On branch main");
    await vi.waitFor(() => expect(host.records.filter(isCallAudit)).toHaveLength(1), within);
    expect(host.records.filter(isCallAudit)[0]).toMatchObject({
      entry: { decision: "allow", reason: "read-only command" },
    });
  });

  describe("a repository planted in the same message as the git command (MC17)", () => {
    function plantAndRun(): { script: object; marker: string } {
      const marker = join(bed.cwd, "ran.marker");
      const hook = join(bed.cwd, "hook.sh");
      writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      const file = (name: string, content: string, id: string) => ({
        name: "write",
        args: { path: join(bed.cwd, "hm", name), content },
        id,
      });
      return {
        marker,
        script: {
          steps: [
            {
              toolCalls: [
                file("HEAD", "ref: refs/heads/main\n", "w1"),
                file("config", `${CLEAN}\tfsmonitor = ${hook}\n`, "w2"),
                file("objects/.keep", "", "w3"),
                file("refs/.keep", "", "w4"),
                { name: "bash", args: { command: "git -C hm status" }, id: "g1" },
              ],
            },
            { text: "done" },
          ],
        },
      };
    }

    it("asks for the git command, and a denial keeps the planted program from running", async () => {
      const { script, marker } = plantAndRun();
      await bed.start(script, { env: { PATH }, policy: ON });
      const host = bed.host();
      host.send({ type: "prompt", id: "p1", message: "go" });
      const ask = await host.waitFor(isApproval);
      expect(ask).toMatchObject({ category: "exec", tool: "bash", toolCallId: "g1" });
      host.send({ type: "approval_response", id: ask.id, answer: "deny" });
      await vi.waitFor(() => expect(host.records.filter(isCallAudit)).toHaveLength(5), within);
      expect(host.records.filter(isApproval)).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
    });
  });
});
