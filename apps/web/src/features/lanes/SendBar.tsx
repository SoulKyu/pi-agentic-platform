import { Button, InlineError } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import "./register-review-catalog.ts";

interface SendBarProps {
  readonly ready: number;
  readonly sessionLabel: string | null;
  readonly busy: boolean;
  readonly problem: boolean;
  onSend(): void;
  onNewSession(): void;
}

/** "3 comments ready · New session · Send to Atlas" (board 10). Nothing goes anywhere until a button is pressed. */
export function SendBar({ ready, sessionLabel, busy, problem, onSend, onNewSession }: SendBarProps) {
  const t = useT();
  const label =
    ready === 0
      ? t("lanes.review.send.none")
      : ready === 1
        ? t("lanes.review.send.ready.one")
        : t("lanes.review.send.ready.many", { count: ready });
  return (
    <div
      data-slot="review-send"
      className="flex flex-wrap items-center justify-between gap-s2 border-t border-border px-s3 py-s2"
    >
      <div className="flex flex-wrap items-center gap-s2">
        <span role="status" className="text-ui text-muted">
          {label}
        </span>
        {problem ? <InlineError announce="action">{t("lanes.review.send.failed")}</InlineError> : null}
      </div>
      <span className="flex items-center gap-s2">
        <Button variant="secondary" size="sm" disabled={ready === 0 || busy} onClick={onNewSession}>
          {t("lanes.review.send.new")}
        </Button>
        {sessionLabel === null ? null : (
          <Button variant="primary" size="sm" disabled={ready === 0 || busy} onClick={onSend}>
            {t("lanes.review.send.to", { session: sessionLabel })}
          </Button>
        )}
      </span>
    </div>
  );
}
