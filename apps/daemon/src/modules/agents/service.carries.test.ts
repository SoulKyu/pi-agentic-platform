import { existsSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { AgentLinks } from "./links.ts";
import { createThreadLink } from "./thread-link.ts";
import { agentInput, createAgentsBed, type AgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());
const { refusalOf } = bedHelpers(() => bed);

async function made() {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  bed.db.run("UPDATE agents SET thread_session_id = 's1'");
  return { id, home: join(bed.papHome, "agents", id) };
}
const paused = (id: string): boolean => bed.agents.port.get("u1", id)?.paused ?? false;

describe("delete: a warm thread takes a prompt during the await (Task 7 carry 4)", () => {
  it("is busy again after cancelling the queue: session_busy, nothing moved, paused as it was", async () => {
    const { id, home } = await made();
    let busy = false;
    let promptArrives = true;
    const vault = vi.fn();
    const links: AgentLinks = {
      threads: { busy: () => busy, archive: vi.fn(), releaseIdle: vi.fn() },
      automation: {
        busy: () => false,
        deleteTriggersOf: vi.fn(),
        cancelQueuedOf: async () => {
          await Promise.resolve();
          busy = promptArrives;
        },
      },
      vault: { drop: vault },
    };
    bed.agents.setLinks(links);
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("session_busy");
    expect(links.threads?.archive).not.toHaveBeenCalled();
    expect(vault).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(true);
    expect(bed.agents.port.get("u1", id)).not.toBeNull();
    expect(paused(id)).toBe(false);
    // The retry finds the rest done and finishes.
    busy = false;
    promptArrives = false;
    bed.agents.setPaused("u1", id, true);
    await bed.agents.remove(bed.owner(), id);
    expect(bed.agents.port.get("u1", id)).toBeNull();
  });

  it("lets the thread's worker go after archiving it and before the home moves", async () => {
    const { id, home } = await made();
    const order: string[] = [];
    bed.agents.setLinks({
      threads: {
        busy: () => false,
        archive: () => order.push("archive"),
        releaseIdle: () => order.push(`release home=${existsSync(home)}`),
      },
      vault: { drop: () => order.push(`vault home=${existsSync(home)}`) },
    });
    await bed.agents.remove(bed.owner(), id);
    expect(order).toEqual(["archive", "release home=true", "vault home=true"]);
    expect(existsSync(home)).toBe(false);
  });

  it("is refused while the thread is being opened", async () => {
    const { id } = await made();
    bed.guard.opening.add(id);
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("session_busy");
    expect(paused(id)).toBe(false);
    bed.guard.opening.delete(id);
    await bed.agents.remove(bed.owner(), id);
    expect(bed.agents.port.get("u1", id)).toBeNull();
  });
});

describe("delete: the thread's session row is gone (Task 7 carry 3)", () => {
  it("deletes the agent through the sessions-backed link, whose calls answer not_found for the row", async () => {
    const { id } = await made();
    const gone = () => {
      throw new PapError("not_found");
    };
    const made_ = createThreadLink({
      automation: {
        state: () => null,
        promptPending: gone,
        archive: gone,
        onAttention: () => () => {},
        abort: async () => {},
      },
      agentSessions: { applyLive: async () => "cold" },
      releaseIdle: gone,
      runs: { onRunEnd: () => () => {} },
      clock: bed.clock,
      logger: silentLogger,
    });
    bed.agents.setLinks({ threads: made_.link });
    const answer = await bed.agents.remove(bed.owner(), id);
    expect(answer.trashedAs).toBe("atlas-0000-1700000000000");
    expect(bed.agents.port.get("u1", id)).toBeNull();
  });
});
