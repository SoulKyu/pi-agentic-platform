import {
  type Caller,
  MEMORY_LIMITS,
  type MemoryItemView,
  type MemoryJournalView,
  type MemoryScopeRef,
  type MemoryScopeView,
  type MemoryStatus,
  PapError,
  type StagedFactView,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import {
  isInstalled,
  listStaged,
  readStagedFact,
  requestForget,
  requestSave,
  requestScope,
  writeDecision,
} from "./mem0-files.ts";
import { REVIEW_KIND } from "./review.ts";
import { readHealth, readItems, readJournal, readProjects } from "./snapshots.ts";

export interface MemoryServiceDeps {
  readonly dir: string;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Pick<Logger, "warn" | "error">;
  readonly readOnly: boolean;
  readonly audit: Pick<AuditPort, "append">;
  readonly inbox: {
    resolveRef(
      ownerId: string,
      kind: string,
      refId: string,
      resolution: "answered" | "timed_out" | null,
    ): boolean;
  };
  /** The agents registry: an agent that is not the owner's is `not_found`. */
  readonly agents: {
    get(ownerId: string, agentId: string): unknown;
    list(ownerId: string): ReadonlyArray<{ readonly id: string; readonly name: string }>;
  };
}

const actorOf = (caller: Caller): { actor: "user" | "token"; actorId: string } => ({
  actor: caller.kind === "token" ? "token" : "user",
  actorId: caller.credentialId.slice(0, 128),
});

/**
 * The memory methods (M11R147). Memories can hold private facts: every method but the status is the browser's, and a
 * token caller is refused here as well as by its permissions. Nothing here touches the store; a change is a request file
 * pi-mem0 applies later.
 */
export function createMemoryService(deps: MemoryServiceDeps) {
  const { dir } = deps;

  const browser = (caller: Caller): void => {
    if (caller.kind === "token") throw new PapError("forbidden");
  };
  const writable = (): void => {
    if (deps.readOnly) throw new PapError("read_only");
  };
  /** The scope as a request spells it; an agent that is not the caller's is `not_found`, an unsafe id `bad_request`. */
  function scoped(caller: Caller, scope: MemoryScopeRef): string {
    const spelled = requestScope(scope);
    if (spelled === null) throw new PapError("bad_request");
    if (scope.kind === "agent" && !deps.agents.get(caller.userId, scope.id)) throw new PapError("not_found");
    return spelled;
  }
  const audited = (caller: Caller, reason: string, scope: string, op: string, count: number): void =>
    deps.audit.append({
      ownerId: caller.userId,
      ...actorOf(caller),
      kind: "policy",
      reason,
      detail: { scope, op, count },
    });
  /** A failure to write a request: codes only, nothing the file system said. */
  function failed(error: unknown): PapError {
    if (error instanceof PapError) return error;
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("mem0: bad") || message === "mem0: request too large")
      return new PapError("bad_request");
    deps.logger.error("memory_request_failed", {
      code: (error as { code?: unknown } | null)?.code ?? "unknown",
    });
    return new PapError("command_failed");
  }
  const installed = (): void => {
    if (!isInstalled(dir)) throw new PapError("command_failed");
  };

  return {
    /** A token gets the watcher state only: pi-mem0's last capture error can quote what it was extracting (final review M3). */
    status(caller: Caller): MemoryStatus {
      if (!isInstalled(dir))
        return {
          installed: false,
          watcher: "unknown",
          checkedAt: null,
          lastCaptureError: null,
          lastCaptureAt: null,
        };
      const health = readHealth(dir, deps.clock.now());
      return {
        installed: true,
        watcher: health.state,
        checkedAt: health.checkedAt,
        lastCaptureError: caller.kind === "token" ? null : health.lastCaptureError,
        lastCaptureAt: caller.kind === "token" ? null : health.lastCaptureAt,
      };
    },

    scopes(caller: Caller): { scopes: MemoryScopeView[] } {
      browser(caller);
      const scopes: MemoryScopeView[] = [{ scope: { kind: "user" }, label: null }];
      if (isInstalled(dir))
        for (const project of readProjects(dir))
          scopes.push({ scope: { kind: "project", id: project.id }, label: project.name });
      for (const agent of deps.agents.list(caller.userId))
        scopes.push({ scope: { kind: "agent", id: agent.id }, label: agent.name });
      return { scopes };
    },

    list(caller: Caller, scope: MemoryScopeRef): { items: MemoryItemView[]; journal: MemoryJournalView[] } {
      browser(caller);
      scoped(caller, scope);
      if (!isInstalled(dir)) return { items: [], journal: [] };
      return {
        items: readItems(dir, scope),
        journal: scope.kind === "agent" ? readJournal(dir, scope.id) : [],
      };
    },

    /** Every id is checked against one read of the scope's snapshot first; one unknown id writes nothing. */
    forget(caller: Caller, input: { scope: MemoryScopeRef; ids: string[] }): { requested: number } {
      browser(caller);
      writable();
      const spelled = scoped(caller, input.scope);
      const known = new Set(readItems(dir, input.scope).map((item) => item.id));
      const ids = [...new Set(input.ids)];
      if (ids.some((id) => !known.has(id))) throw new PapError("not_found");
      let written = 0;
      try {
        for (const id of ids) {
          requestForget(dir, input.scope, id);
          written += 1;
        }
      } catch (error) {
        throw failed(error);
      } finally {
        // A forget that stopped half way still leaves a trace of the requests that were written.
        if (written > 0) audited(caller, "memory forget", spelled, "forget", written);
      }
      return { requested: written };
    },

    /** Promote (a text saved in `user`) or correct (`replaces`, checked in the same scope's snapshot). */
    save(
      caller: Caller,
      input: { scope: MemoryScopeRef; text: string; replaces?: string | undefined },
    ): Record<string, never> {
      browser(caller);
      writable();
      const spelled = scoped(caller, input.scope);
      // Without `replaces` a save is a promotion, which only the user scope receives.
      if (input.replaces === undefined && input.scope.kind !== "user") throw new PapError("bad_request");
      installed();
      if (
        input.replaces !== undefined &&
        !readItems(dir, input.scope).some((item) => item.id === input.replaces)
      )
        throw new PapError("not_found");
      try {
        requestSave(dir, input.scope, input.text, input.replaces);
      } catch (error) {
        throw failed(error);
      }
      audited(caller, "memory save", spelled, input.replaces === undefined ? "promote" : "correct", 1);
      return {};
    },

    /** The queue for this owner's agents. The text is untrusted: every view fences it. */
    staged(caller: Caller): { facts: StagedFactView[] } {
      browser(caller);
      const facts: StagedFactView[] = [];
      const owned = (agent: string): boolean => Boolean(deps.agents.get(caller.userId, agent));
      for (const fact of listStaged(dir, { accept: owned, now: deps.clock.now() })) {
        facts.push({
          factId: fact.id,
          agentId: fact.agent,
          text: fact.text,
          createdAt: fact.createdAt,
          decision: fact.decision,
          applying: fact.applying,
          untrusted: true,
        });
        if (facts.length >= MEMORY_LIMITS.staged) break;
      }
      return { facts };
    },

    decide(caller: Caller, input: { factId: string; approved: boolean }): Record<string, never> {
      browser(caller);
      writable();
      const fact = readStagedFact(dir, input.factId, deps.clock.now());
      let outcome: ReturnType<typeof writeDecision> = "not_found";
      if (fact !== null && deps.agents.get(caller.userId, fact.agent)) {
        try {
          outcome = writeDecision(dir, input.factId, input.approved, deps.clock.now());
        } catch (error) {
          throw failed(error);
        }
      }
      if (outcome === "not_found") {
        // The fact is gone: whatever item still points at it is closed.
        deps.inbox.resolveRef(caller.userId, REVIEW_KIND, input.factId, null);
        throw new PapError("not_found");
      }
      if (outcome === "applying") throw new PapError("conflict");
      deps.inbox.resolveRef(caller.userId, REVIEW_KIND, input.factId, "answered");
      audited(caller, "memory decide", "staging", input.approved ? "approve" : "reject", 1);
      return {};
    },
  };
}
export type MemoryService = ReturnType<typeof createMemoryService>;
