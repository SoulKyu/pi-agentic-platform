import { vi } from "vitest";
import { PapError } from "@pap/contracts";
import type { SessionsAgentPort } from "../../sessions/index.ts";

export type ThreadState = NonNullable<ReturnType<SessionsAgentPort["threadState"]>>;
export const QUIET: ThreadState = { running: false, needsInput: false, starting: false, archived: false };

/** A fake sessions port: `createAgentSession` hands out `t1`, `t2`, ... (held when asked) and `threadState` reads `states`. */
export function fakeSessions() {
  const states = new Map<string, ThreadState>();
  const gate: { release: (() => void) | null; hold: boolean; failWith: string | null } = {
    release: null,
    hold: false,
    failWith: null,
  };
  let next = 0;
  const createAgentSession = vi.fn<SessionsAgentPort["createAgentSession"]>(async () => {
    if (gate.failWith) throw new PapError(gate.failWith as "capacity");
    const sessionId = `t${++next}`;
    if (gate.hold) await new Promise<void>((resolve) => (gate.release = resolve));
    states.set(sessionId, { ...QUIET });
    return { sessionId };
  });
  return {
    states,
    gate,
    createAgentSession,
    port: {
      createAgentSession,
      threadState: (_ownerId: string, sessionId: string) => states.get(sessionId) ?? null,
    } as unknown as Pick<SessionsAgentPort, "createAgentSession" | "threadState">,
  };
}
