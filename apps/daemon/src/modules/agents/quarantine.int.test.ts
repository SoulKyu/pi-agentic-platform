import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createSandboxProbe } from "../../kernel/sandbox/probe.ts";
import { testCaller } from "../../testing/caller.ts";
import { createOnceStore } from "../secrets/index.ts";
import { createIntBed, type IntBed } from "../sessions/testing/int-bed.ts";
import { createQuarantine } from "./quarantine.ts";
import { createThreadLink } from "./thread-link.ts";

// The real sessions module on a real worker: the archive that quarantine runs is the one that ends a thread's host grants.
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
if (!usable && process.env.CI) throw new Error("quarantine.int.test: CI must provide a working bwrap");
if (!usable) console.warn("quarantine.int.test: skipped: no usable /usr/bin/bwrap on this machine");

const ID = "atlas-1a2b";
let bed: IntBed;
afterEach(async () => {
  await bed?.dispose();
});

describe.skipIf(!usable)("quarantine over a real thread session (W5-R52)", () => {
  it("leaves the thread archived, with no host grants and no one-use values", async () => {
    bed = await createIntBed({ steps: [{ text: "placeholder" }] });
    mkdirSync(join(bed.papHome, "agents", ID), { recursive: true, mode: 0o700 });
    const clock = createSystemClock();
    const probe = createSandboxProbe({ override: undefined, clock, logger: silentLogger });
    await probe.recheck();
    bed.sessions.setAgentPorts({
      agents: {
        profileOf: (ownerId, agentId) =>
          ownerId === "u1" && agentId === ID
            ? { input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }
            : null,
        vaultOf: () => ({}),
        probe,
      },
    });
    const { sessionId } = await bed.sessions.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "thread",
    });
    // The module hands out the real object and its type hides `note`: the owner's Allow-this-host answer is what calls it.
    (bed.sessions.hostGrants as unknown as { note(sessionId: string, host: string): void }).note(
      sessionId,
      "api.example.com",
    );
    const once = createOnceStore(() => clock.now());
    once.put("secret-ref:00000000000000000000000000000001", {
      id: "o1",
      agentId: ID,
      sessionId,
      name: "TOKEN",
      value: "one-use-value",
    });
    expect(bed.sessions.hostGrants.of(sessionId)).toEqual(["api.example.com"]);
    expect(once.forSession(sessionId)).toHaveLength(1);

    const threadLink = createThreadLink({
      automation: bed.sessions.automation,
      agentSessions: bed.sessions.agentSessions,
      releaseIdle: bed.sessions.releaseIdle,
      runs: { onRunEnd: () => () => undefined },
      clock,
      logger: silentLogger,
    });
    const quarantine = createQuarantine({
      store: {
        get: () => ({ threadSessionId: sessionId }) as never,
        quarantine: () => true,
        clearThread: () => true,
      },
      links: () => ({
        threads: threadLink.link,
        onceValues: { drop: (_ownerId, agentId) => void once.dropAgent(agentId) },
      }),
      guard: { quarantining: new Map() },
      lock: (_agentId, work) => work(),
      clock,
      logger: silentLogger,
      audit: { append: () => undefined } as never,
      requireStepUp: () => undefined,
      changed: () => undefined,
    });
    const answer = await quarantine.run(testCaller(), ID);
    threadLink.stop();

    expect(answer.errors).toEqual([]);
    expect(bed.sessions.agentSessions.threadState("u1", sessionId)?.archived).toBe(true);
    expect(bed.sessions.hostGrants.of(sessionId)).toEqual([]);
    expect(once.forSession(sessionId)).toEqual([]);
  });
});
