import "../../i18n/register-previews.ts";
import type { BoxPhase } from "@pap/contracts";
import { Button, InlineError, usePendingAction } from "@pap/ui";
import { useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { useProjectBox } from "../boxes/use-project-box.ts";

const COMMAND_CHARS = 200;
const MARK = "\u0001";

/** The first 200 characters of the declared command, then `…` (UX2-R80): the owner reads what START PREVIEW will run. */
export const clipCommand = (command: string): string =>
  command.length > COMMAND_CHARS ? `${command.slice(0, COMMAND_CHARS)}…` : command;

/**
 * START PREVIEW for the preview `.pi/project.yaml` declares: the command is shown as text, and the daemon starts it
 * only when it is still the one this page showed (`conflict` otherwise: the page reads the new one, UX2-R74).
 */
export function StartDeclared({
  projectId,
  phase,
}: {
  readonly projectId: string;
  readonly phase: BoxPhase;
}) {
  const t = useT();
  const { state, replace } = useProjectBox(projectId, phase);
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  if (state.kind !== "ready") return null;
  const { preview, previewInvalid } = state.box;
  if (previewInvalid === true)
    return <InlineError announce="background">{t("previews.declaredInvalid")}</InlineError>;
  if (preview === null || preview === undefined) return null;
  const [before = "", after = ""] = t("previews.declaredCommand", { command: MARK }).split(MARK);
  const start = () =>
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        await rpc.call(
          "previews.startProject",
          { projectId, command: preview.command, port: preview.port },
          { commandId: rpc.newCommandId() },
        );
        setChanged(false);
      } catch (failure) {
        if (failure instanceof RpcError && failure.code === "conflict") {
          setChanged(true);
          const { box } = await rpc.call("projects.box", { projectId }).catch(() => {
            reportClientIssue("command_failed");
            return { box: null };
          });
          if (box !== null) replace(box);
        } else setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });
  return (
    <div className="flex flex-col items-start gap-s1">
      <p className="text-ui text-muted">{t("previews.declared", { port: preview.port })}</p>
      <p className="min-w-0 break-words text-ui text-muted">
        {before}
        <code className="font-mono text-code text-fg">{clipCommand(preview.command)}</code>
        {after}
      </p>
      {changed ? (
        <InlineError announce="background" tone="attn">
          {t("previews.changed")}
        </InlineError>
      ) : null}
      <Button variant="secondary" pendingSince={pending.since} onClick={start}>
        {t("previews.start")}
      </Button>
      {problem === null ? null : <InlineError announce="action">{problem}</InlineError>}
    </div>
  );
}
