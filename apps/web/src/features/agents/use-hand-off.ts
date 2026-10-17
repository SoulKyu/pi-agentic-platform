import "./register-space-catalog.ts";
import type { AgentSummary } from "@pap/contracts";
import { toast } from "@pap/ui";
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useHandOffPorts } from "../../stores/composer-hand-off.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { lastAssistantQuote, parseHandOff } from "./hand-off.ts";

/**
 * The agent thread's `@Name text` hand-off (M11R123): the composer asks this port before it sends. A text that starts
 * with another agent's exact name and carries a text is queued for that agent with the thread's last assistant message
 * as the quote, and a toast offers Undo (it cancels the task). A refusal gives the text back to the composer.
 */
export function useHandOff(agentId: string, sessionId: string | null, agents: readonly AgentSummary[]): void {
  const t = useT();
  const latest = useRef({ t, agents });
  useEffect(() => {
    latest.current = { t, agents };
  });
  const names = agents.filter((agent) => agent.id !== agentId).map((agent) => agent.name);
  const key = names.join("\n");
  useEffect(() => {
    if (sessionId === null) return;
    const handOff = (text: string): boolean => {
      const { t: say, agents: all } = latest.current;
      const found = parseHandOff(text, agentId, all);
      if (found === null) return false;
      const quote = lastAssistantQuote(useSessionStore.getState().views[sessionId]?.messages ?? []);
      const { rpc } = getRuntime();
      const failed = () => {
        useComposerPrefill.getState().push(sessionId, text);
        toast({ tone: "error", message: say("agentCompose.handOff.failed", { name: found.name }) });
      };
      rpc
        .call(
          "agents.queueTask",
          {
            agentId: found.agentId,
            prompt: found.prompt,
            ...(quote === undefined ? {} : { handOff: { fromAgentId: agentId, quote } }),
          },
          { commandId: rpc.newCommandId() },
        )
        .then(({ taskId }) => {
          const paused = all.find((agent) => agent.id === found.agentId)?.paused ?? false;
          toast({
            message: say(paused ? "agentCompose.handOff.queuedPaused" : "agentCompose.handOff.queued", {
              name: found.name,
            }),
            action: {
              label: say("agentCompose.handOff.undo"),
              altText: say("agentCompose.handOff.undoAlt", { name: found.name }),
              run: () =>
                void rpc
                  .call("automation.tasks.cancel", { taskId }, { commandId: rpc.newCommandId() })
                  .catch(() => {
                    reportClientIssue("agent_hand_off_undo_failed");
                    toast({
                      tone: "error",
                      message: say("agentCompose.handOff.undoFailed", { name: found.name }),
                    });
                  }),
            },
          });
        })
        .catch((failure: unknown) => {
          reportClientIssue("agent_hand_off_failed");
          // The call may have gone through: giving the text back would invite a second task.
          if (failure instanceof RpcError && ["timeout", "connection_lost"].includes(failure.code))
            toast({ tone: "error", message: say("agentCompose.handOff.unsure") });
          else failed();
        });
      return true;
    };
    return useHandOffPorts
      .getState()
      .register(sessionId, { names: key === "" ? [] : key.split("\n"), handOff });
  }, [agentId, sessionId, key]);
}
