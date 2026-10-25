import "../../i18n/register-launch.ts";
import type { Waiting } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { waitingWords } from "./launch-view.ts";

/**
 * What a launch or a task waits for, in neutral text (waiting is not a failure): the reason, how long until the next try,
 * then what frees it. A freeing action that needs a screen is a button only where the host gave one.
 */
export function WaitingLine({
  waiting,
  now,
  onAction,
}: {
  readonly waiting: Waiting;
  readonly now: number;
  onAction?: (() => void) | undefined;
}) {
  const t = useT();
  const words = waitingWords(waiting, now, t);
  return (
    <div className="flex flex-wrap items-center gap-x-s2 text-ui text-muted">
      <p data-waiting="">{words.text}</p>
      {words.action?.kind === "hint" ? <p>{words.action.label}</p> : null}
      {words.action?.kind === "button" && onAction ? (
        <Button size="sm" variant="ghost" onClick={onAction}>
          {words.action.label}
        </Button>
      ) : null}
    </div>
  );
}
