import { AgentStatus } from "@pap/contracts";
import { useEffect, useRef, useState } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { agentById } from "../../stores/agents-reducer.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { feedTasks } from "../../stores/tasks-feed.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";

/** The stream's word is folded for this long before the panel reads again. */
export const STATUS_REFRESH_MS = 1000;

export type StatusLoad =
  | { readonly kind: "loading" }
  /** `refreshFailed`: the last read failed; `status` is the one before it. */
  | { readonly kind: "ready"; readonly status: AgentStatus; readonly refreshFailed: boolean }
  /** The first read failed: there is nothing to show. */
  | { readonly kind: "failed" };

/**
 * What moves when this agent's cards, state or tasks move: the stream's word, as one string. The first `tasks` snapshot
 * the panel sees is the baseline, not news: the read made on open already holds those tasks.
 */
function useStatusStamp(agentId: string): string {
  const agent = useAgents((view) => agentById(view, agentId));
  const ticks = useAgents((view) => view.cardTicks[agentId] ?? 0);
  const tasks = useTasksStore((state) =>
    state.view.list
      .filter((task) => task.agentId === agentId)
      .map((task) => `${task.id}:${task.state}:${task.costUsd}`)
      .join(","),
  );
  const loaded = useTasksStore((state) => state.view.loaded);
  const [baseline, setBaseline] = useState<{ readonly agentId: string; readonly tasks: string } | null>(null);
  if (loaded && (baseline === null || baseline.agentId !== agentId)) setBaseline({ agentId, tasks });
  const news = loaded && baseline?.agentId === agentId && baseline.tasks === tasks ? "" : tasks;
  return `${agent?.state}:${agent?.lastActivityAt}:${agent?.paused}:${ticks}:${news}`;
}

/**
 * `agents.status`, read when the panel opens and again a second after the agents stream or the tasks stream says
 * something about this agent. Never polled: nothing moves, nothing is read. The `tasks` stream stays open while the
 * panel is mounted. A newer read replaces an older one still in flight.
 */
export function useAgentStatus(agentId: string) {
  const stamp = useStatusStamp(agentId);
  const [load, setLoad] = useState<StatusLoad>({ kind: "loading" });
  const latest = useRef(0);
  const seen = useRef<{ readonly agentId: string; readonly stamp: string } | null>(null);

  const read = () => {
    latest.current += 1;
    const mine = latest.current;
    getRuntime()
      .rpc.call("agents.status", { agentId })
      .then((raw) => {
        if (mine === latest.current)
          setLoad({ kind: "ready", status: AgentStatus.parse(raw), refreshFailed: false });
      })
      .catch(() => {
        reportClientIssue("agent_status_failed");
        // A failed refetch keeps the figures on screen; only a failed first read has nothing to show.
        if (mine === latest.current)
          setLoad((previous) =>
            previous.kind === "ready" ? { ...previous, refreshFailed: true } : { kind: "failed" },
          );
      });
  };

  const ask = useRef(read);
  useEffect(() => {
    ask.current = read;
  });
  useEffect(() => feedTasks(getRuntime().subscriptions, () => reportClientIssue("tasks_feed_failed")), []);
  useEffect(() => {
    const before = seen.current;
    seen.current = { agentId, stamp };
    // Opening (or a remount of the same state) reads now; a moved stamp waits out the debounce.
    if (before === null || before.agentId !== agentId || before.stamp === stamp) {
      ask.current();
      return () => {
        latest.current += 1;
      };
    }
    const timer = setTimeout(() => ask.current(), STATUS_REFRESH_MS);
    return () => {
      clearTimeout(timer);
      latest.current += 1;
    };
  }, [agentId, stamp]);

  return {
    load,
    retry: () => {
      setLoad((previous) => (previous.kind === "ready" ? previous : { kind: "loading" }));
      read();
    },
  };
}
