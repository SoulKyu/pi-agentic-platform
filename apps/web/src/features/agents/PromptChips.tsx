import "./register-space-catalog.ts";
import { Button } from "@pap/ui";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { stripHidden } from "./untrusted-text.ts";

const ACTIVITY_QUIET_MS = 1000;

/**
 * The prompt chips (M11R122): one per `.md` file of the agent's `prompts/` folder. The folder is the agent's to write, so
 * a name is shown as text, and a click only puts the file's text in the composer for the owner to read and send: nothing
 * is sent from here. `refreshKey` moving (the agent was active) reads the names again, one second after the last move.
 */
export function PromptChips({
  agentId,
  sessionId,
  refreshKey,
}: {
  readonly agentId: string;
  readonly sessionId: string;
  readonly refreshKey: string;
}) {
  const t = useT();
  const [names, setNames] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState(false);
  const last = useRef<{ readonly agentId: string; readonly key: string } | null>(null);
  useEffect(() => {
    let current = true;
    const read = () =>
      getRuntime()
        .rpc.call("agents.prompts", { agentId })
        .then(({ names: listed }) => current && setNames(listed))
        .catch(() => {
          reportClientIssue("agent_prompts_failed");
          if (current) setNames([]);
        });
    // The first read of an agent is at once; its activity ticks (a busy thread moves the key often) wait until quiet.
    // The timer is trailing: each move cancels it (the cleanup below) and starts it again, so the read happens only
    // after a full quiet second with no move. A thread that never pauses for a second never re-reads the names.
    const ticked = last.current?.agentId === agentId && last.current.key !== refreshKey;
    last.current = { agentId, key: refreshKey };
    const timer = ticked ? setTimeout(read, ACTIVITY_QUIET_MS) : undefined;
    if (!ticked) void read();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [agentId, refreshKey]);
  const fill = (name: string) => {
    setFailed(false);
    getRuntime()
      .rpc.call("agents.prompt", { agentId, name })
      .then(({ text }) => useComposerPrefill.getState().push(sessionId, stripHidden(text)))
      .catch(() => {
        reportClientIssue("agent_prompt_failed");
        setFailed(true);
      });
  };
  if (names.length === 0) return null;
  return (
    <div className="flex flex-col gap-s1">
      <div role="group" aria-label={t("agentCompose.chips.region")} className="flex flex-wrap gap-s2">
        {names.map((name) => (
          <Button key={name} size="sm" variant="secondary" onClick={() => fill(name)}>
            {stripHidden(name)}
          </Button>
        ))}
      </div>
      {failed ? (
        <p role="alert" className="text-ui text-attn">
          {t("agentCompose.chips.failed")}
        </p>
      ) : null}
    </div>
  );
}
