import { usePendingAction } from "@pap/ui";
import { useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { githubFailure } from "./github-errors.ts";

export type SendSource =
  { readonly kind: "check"; readonly checkId: string } | { readonly kind: "issue"; readonly number: number };

/** The key of one source, to tell which row's button spins. */
export const sourceKey = (source: SendSource): string =>
  source.kind === "check" ? `check:${source.checkId}` : `issue:${source.number}`;

/**
 * `projects.sendToSession`: a failed check or an issue goes to a new session of the project, which the daemon fences as
 * GitHub text and taints. The answer's session opens; a refusal stays as `problem`.
 */
export function useSendToSession(projectId: string, onOpenSession: (sessionId: string) => void) {
  const pending = usePendingAction();
  const [sending, setSending] = useState<string | null>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const send = (source: SendSource) => {
    setSending(sourceKey(source));
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        const { sessionId } = await rpc.call(
          "projects.sendToSession",
          { projectId, source },
          { commandId: rpc.newCommandId() },
        );
        onOpenSession(sessionId);
      } catch (failure) {
        setProblem(githubFailure(failure));
      }
    });
  };
  return { since: pending.since, sending, problem, send };
}
