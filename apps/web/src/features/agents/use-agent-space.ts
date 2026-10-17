import { AgentEventView } from "@pap/contracts";
import { useEffect, useState } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

export type OpenState =
  | { readonly kind: "opening" }
  | { readonly kind: "ready"; readonly sessionId: string }
  | { readonly kind: "failed"; readonly code: string };

/**
 * The agent's one trusted thread (M11R59): `agents.openThread` when the tab opens, and again on `reopen` (after a reset
 * the next thread is a new session). `skip`: the agent cannot open one (quarantined, unreadable), so nothing is asked.
 */
export function useOpenThread(agentId: string, skip: boolean) {
  const [round, setRound] = useState(0);
  const key = `${agentId}:${round}`;
  // The answer belongs to the (agent, round) that asked: a newer ask shows "opening" again without a state write.
  const [answer, setAnswer] = useState<{ readonly key: string; readonly value: OpenState } | null>(null);
  useEffect(() => {
    if (skip) return;
    let current = true;
    const { rpc } = getRuntime();
    rpc
      .call("agents.openThread", { agentId }, { commandId: rpc.newCommandId() })
      .then(({ sessionId }) => current && setAnswer({ key, value: { kind: "ready", sessionId } }))
      .catch(
        (failure: unknown) =>
          current &&
          setAnswer({
            key,
            value: { kind: "failed", code: failure instanceof RpcError ? failure.code : "internal" },
          }),
      );
    return () => {
      current = false;
    };
  }, [agentId, skip, key]);
  const state: OpenState = answer?.key === key ? answer.value : { kind: "opening" };
  return { state, reopen: () => setRound((n) => n + 1) };
}

const NO_CARDS: readonly AgentEventView[] = [];

/**
 * The thread's newest cards (`agents.events`, newest first, one page), read again whenever `tick` moves: the stream says a
 * card was written or changed. A card this build cannot read is left out.
 */
export function useAgentCards(agentId: string, tick: number): readonly AgentEventView[] {
  // The cards belong to the agent that was read: another agent shows none until its own read answers.
  const [read, setRead] = useState<{ readonly agentId: string; readonly cards: readonly AgentEventView[] }>({
    agentId,
    cards: [],
  });
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("agents.events", { agentId })
      .then((page) => {
        if (!current) return;
        setRead({
          agentId,
          cards: page.events.flatMap((event) => {
            const parsed = AgentEventView.safeParse(event);
            return parsed.success ? [parsed.data] : [];
          }),
        });
      })
      .catch(() => reportClientIssue("agent_cards_failed"));
    return () => {
      current = false;
    };
  }, [agentId, tick]);
  return read.agentId === agentId ? read.cards : NO_CARDS;
}

/** Whether the page is in front of the person (a hidden tab reads nothing). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}

export const READ_AFTER_MS = 1000;

/**
 * Marks the thread read once its newest entry has been in view for a second (pi-web's rule). The pane is mounted only
 * while its tab is shown, so "in view" is: the thread is open and the page is visible. New unread starts the second again.
 */
export function useMarkRead(agentId: string, unread: number, inView: boolean): void {
  const visible = usePageVisible();
  useEffect(() => {
    if (!inView || !visible || unread === 0) return;
    const timer = setTimeout(() => {
      const { rpc } = getRuntime();
      void rpc
        .call("agents.markRead", { agentId }, { commandId: rpc.newCommandId() })
        .catch(() => reportClientIssue("agent_mark_read_failed"));
    }, READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [agentId, unread, inView, visible]);
}

/** The current time, moved on every `everyMs` (the time left on a request). */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
