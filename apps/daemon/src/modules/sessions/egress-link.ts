import { EgressClose, EgressOpen, type PolicyRules } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { CommandReport, EgressPort, EgressScope } from "../egress/index.ts";
import type { HostGrants } from "./host-grants.ts";
import type { SessionRow } from "./store.ts";

export type { EgressPort } from "../egress/index.ts";

/** A report that was never made reads as cut: the worker taints (M11R233). */
const cut = (): CommandReport => ({ hosts: [], truncated: true, up: 0, down: 0 });

/**
 * What a worker's commands are judged against, fixed at its start (W5-R26, M11R243): the composed rules' host list and trusted
 * sources, copied, and the thread's live grants. Null for whoever has no network through the proxy: an owner session, a child,
 * an agent with the sandbox or the network off. No host list is an empty one (C 5.3).
 */
export function egressScopeOf(
  row: SessionRow,
  rules: Pick<PolicyRules, "allowHosts" | "trustedSources" | "sandbox">,
  grants: Pick<HostGrants, "of">,
): EgressScope | null {
  const { agentId, agentRole } = row;
  if (agentId === undefined || (agentRole !== "thread" && agentRole !== "task")) return null;
  if (rules.sandbox?.required !== true || !rules.sandbox.network) return null;
  return {
    ownerId: row.ownerId,
    agentId,
    sessionId: row.id,
    hosts: [...(rules.allowHosts ?? [])],
    trustedSources: [...rules.trustedSources],
    grants: () => (agentRole === "thread" ? grants.of(row.id) : []),
  };
}

/**
 * A third listener on a worker's handle (beside the live session's and the platform's): its `egress_open` / `egress_close` go
 * to the egress port with the worker's scope, and the answers go back with `handle.send`. The worker's command id is mapped to the
 * proxy's, and a close names the session, so one worker never closes another's command. At exit the commands end and, unless a
 * newer worker of the same session took over, the session's folder is dropped.
 */
export function createEgressLink(logger: Logger) {
  const newest = new Map<string, object>();
  return function bridgeEgress(
    handle: Pick<WorkerHandle, "onRecord" | "send" | "exited">,
    scope: EgressScope | null,
    port: () => EgressPort | undefined,
  ): void {
    const key = scope?.sessionId ?? null;
    const mine = {};
    const commands = new Map<string, string | null>();
    let gone = false;
    if (key !== null) newest.set(key, mine);
    const guarded = (work: () => Promise<void>): void =>
      void work().catch((error: unknown) =>
        logger.warn("egress_link_failed", {
          sessionId: key,
          errorClass: error instanceof Error ? error.constructor.name : "non_error",
        }),
      );
    const refuse = (id: string, reason: "unavailable" | "limit" = "unavailable"): void =>
      void handle.send({ type: "egress_opened", id, socket: null, reason });

    async function open(id: string): Promise<void> {
      const egress = port();
      if (scope === null || key === null || egress === undefined || commands.has(id)) return refuse(id);
      commands.set(id, null);
      let answer: Awaited<ReturnType<EgressPort["openCommand"]>>;
      try {
        answer = await egress.openCommand(scope);
      } catch (error) {
        // The worker would wait out its whole timer, and the id would stay taken.
        commands.delete(id);
        refuse(id);
        throw error;
      }
      if ("reason" in answer) return void (commands.delete(id), refuse(id, answer.reason));
      // The worker went, or closed the id, while the socket was being made: nobody will use it.
      if (gone || !commands.has(id)) {
        await egress.closeCommand(key, answer.id);
        // The exit already dropped the folder, and this open made it again: no newer worker means nobody else holds it.
        if (gone && !newest.has(key)) await egress.dropSession(key);
        return;
      }
      commands.set(id, answer.id);
      handle.send({ type: "egress_opened", id, socket: answer.socket, reason: null });
    }
    async function close(id: string): Promise<void> {
      const proxyId = commands.get(id);
      commands.delete(id);
      const egress = port();
      const report = proxyId && egress && key !== null ? await egress.closeCommand(key, proxyId) : cut();
      handle.send({ type: "egress_report", id, ...report });
    }

    handle.onRecord((record) => {
      const opening = record.type === "egress_open" ? EgressOpen.safeParse(record) : null;
      const closing = record.type === "egress_close" ? EgressClose.safeParse(record) : null;
      if (opening?.success) guarded(() => open(opening.data.id));
      if (closing?.success) guarded(() => close(closing.data.id));
    });
    guarded(async () => {
      await handle.exited;
      gone = true;
      const egress = port();
      if (egress === undefined || key === null) return;
      if (newest.get(key) === mine) {
        newest.delete(key);
        await egress.dropSession(key);
        return;
      }
      for (const proxyId of commands.values()) if (proxyId) await egress.closeCommand(key, proxyId);
    });
  };
}
