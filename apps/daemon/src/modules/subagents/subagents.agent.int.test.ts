import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createSandboxProbe } from "../../kernel/sandbox/probe.ts";
import { createIntBed, type IntBed, promptAndSettle } from "../sessions/testing/int-bed.ts";

// A child of an agent thread on real workers and a real bwrap (RT-07): the thread has the agent's vault, its child never does,
// and a vault change made after the child started reaches the thread's worker only. Skipped with one line without a bwrap.
function bwrapWorks(): boolean {
  try {
    execFileSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "/bin/true"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
const usable = bwrapWorks();
if (!usable && process.env.CI) throw new Error("subagents.agent.int.test: CI must provide a working bwrap");
if (!usable) console.warn("subagents.agent.int.test: skipped: no usable /usr/bin/bwrap on this machine");

const ID = "atlas-1a2b";
const bash = (command: string, id: string) => ({ toolCalls: [{ name: "bash", args: { command }, id }] });

let bed: IntBed;
afterEach(async () => {
  await bed?.dispose();
});

describe.skipIf(!usable)("a child of an agent thread on a real worker (RT-07, M11R136)", () => {
  it("never holds the vault, and a change of the vault reaches the thread's worker only", async () => {
    bed = await createIntBed({ steps: [{ text: "placeholder" }] });
    const home = join(bed.papHome, "agents", ID);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const probe = createSandboxProbe({
      override: undefined,
      clock: createSystemClock(),
      logger: silentLogger,
    });
    await probe.recheck();
    let vault: Record<string, string> = { TOKEN: "vault-1" };
    bed.sessions.setAgentPorts({
      agents: {
        profileOf: (ownerId, agentId) =>
          ownerId === "u1" && agentId === ID
            ? {
                input: AgentInput.parse({ name: "Atlas", preset: "full", mode: "full-access" }),
                name: "Atlas",
                quarantined: false,
              }
            : null,
        vaultOf: () => vault,
        probe,
      },
    });
    const script = (steps: object[]) =>
      writeFileSync(join(bed.root, "script.json"), JSON.stringify({ steps }));
    // The thread's worker reads its script when it starts, the child's reads the next one.
    script([bash("echo [$TOKEN] > thread.txt", "t1"), { text: "done" }]);
    const { sessionId: thread } = await bed.sessions.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "thread",
    });
    script([bash("echo [$TOKEN] > child.txt", "c1"), { text: "done" }]);
    const child = await bed.sessions.child.createChildSession({ ownerId: "u1", parentSessionId: thread });

    // The vault changes after the child started: told to the agent's workers (the thread's only).
    vault = { TOKEN: "vault-2" };
    const told = bed.sessions.agentSessions.sendToAgent("u1", ID, { type: "vault_update", vault, once: [] });
    expect(told).toBe(1);

    const threadSub = await bed.subscribe(thread);
    await promptAndSettle(bed, threadSub, thread, "go");
    const childSub = await bed.subscribe(child.sessionId);
    await promptAndSettle(bed, childSub, child.sessionId, "go");

    expect(readFileSync(join(home, "thread.txt"), "utf8")).toBe("[vault-2]\n");
    // The child's shell runs in the same home with the sandbox and no vault: its environment has no TOKEN at all.
    expect(readFileSync(join(home, "child.txt"), "utf8")).toBe("[]\n");
  });
});
