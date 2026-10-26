import "../../i18n/register-boxes.ts";
import type { BoxPhase, BoxRef } from "@pap/contracts";
import { Button, InlineError, Spinner } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { useBoxStage } from "../launch/use-stage.ts";
import { useBoxAction } from "./use-box-action.ts";
import { useStartFeedback } from "./use-stage.ts";

interface Props {
  /** The box to start: a project's, or an agent's VM (`agents.startBox`, no prompt). */
  readonly box: BoxRef;
  readonly phase: BoxPhase;
  readonly size?: "sm" | "md";
  /** Primary where START is the view's main action; the project home keeps Launch as its one primary. */
  readonly variant?: "primary" | "secondary";
  /** Called once the start call resolved ok, even when it opened no launch (the VM already ran): the caller reads again. */
  readonly onStarted?: () => void;
}

/**
 * START, primary (you fill). Disabled at once, the spinner after 1 s, "Starting the box…" after 3 s (§7.3), whether the
 * wait is this click's or the stream's `starting`. A failed start is shown under the button, in words.
 */
export function BoxStart({ box, phase, size, variant, onStarted }: Props) {
  const t = useT();
  const stageText = t(box.kind === "agent" ? "boxes.agentStage" : "boxes.stage");
  const action = useBoxAction("projects.startBox", box, onStarted);
  // The button speaks for this click's own wait; the status line is for a start the stream reports (one spinner, not two).
  const stage = useBoxStage(box);
  const feedback = useStartFeedback(phase === "starting" && action.since === null);
  return (
    <span className="flex flex-col items-start gap-s1">
      <Button
        variant={variant ?? "primary"}
        size={size ?? "md"}
        remote={false}
        disabled={phase !== "stopped" || action.since !== null}
        pendingSince={action.since}
        stageLabel={stageText}
        stage={stage}
        onClick={action.run}
      >
        {t("boxes.start")}
      </Button>
      {feedback === "quiet" ? null : (
        <span role="status" className="flex items-center gap-s1 text-ui text-muted">
          <Spinner />
          {feedback === "stage" ? stageText : null}
        </span>
      )}
      {action.problem === null ? null : <InlineError announce="action">{action.problem}</InlineError>}
    </span>
  );
}
