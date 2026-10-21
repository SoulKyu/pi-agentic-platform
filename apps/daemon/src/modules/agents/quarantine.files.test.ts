import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { AgentLinks } from "./links.ts";
import { createQuarantine } from "./quarantine.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

async function run(files: NonNullable<AgentLinks["files"]>, log: string[] = []) {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  bed.agents.setLinks({
    files,
    vault: {
      drop: () => undefined,
      list: () => (log.push("vault"), { entries: [], state: "ok" as const }),
    },
    memory: { moveStaged: () => (log.push("memory"), 0) },
  });
  const quarantine = createQuarantine({
    store: bed.agents.store,
    links: bed.agents.links,
    guard: bed.guard,
    lock: async (_agentId, work) => work(),
    clock: bed.clock,
    logger: silentLogger,
    audit: bed.audit,
    requireStepUp: () => {},
    changed: vi.fn(),
  });
  return quarantine.run(bed.owner(), id);
}

describe("quarantine and the agent's files", () => {
  it("lists their paths after the vault names and before the memory, so the owner can revoke at the source", async () => {
    const log: string[] = [];
    const answer = await run(
      { paths: () => (log.push("files"), [".kube/config", "a/token.json"]), dispose: () => undefined },
      log,
    );
    expect(answer.filePaths).toEqual([".kube/config", "a/token.json"]);
    expect(log).toEqual(["vault", "files", "memory"]);
    expect(answer.errors).toEqual([]);
  });

  it("reports a failing files step in errors and still runs the memory step", async () => {
    const log: string[] = [];
    const answer = await run(
      {
        paths: () => {
          throw new Error("unreadable");
        },
        dispose: () => undefined,
      },
      log,
    );
    expect(answer.errors).toEqual([{ step: "files", code: "failed" }]);
    expect(answer.filePaths).toBeUndefined();
    expect(log.at(-1)).toBe("memory");
  });

  it("leaves the answer without file paths when no store is linked", async () => {
    bed = createAgentsBed();
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    const quarantine = createQuarantine({
      store: bed.agents.store,
      links: bed.agents.links,
      guard: bed.guard,
      lock: async (_agentId, work) => work(),
      clock: bed.clock,
      logger: silentLogger,
      audit: bed.audit,
      requireStepUp: () => {},
      changed: vi.fn(),
    });
    expect((await quarantine.run(bed.owner(), id)).filePaths).toBeUndefined();
  });
});
