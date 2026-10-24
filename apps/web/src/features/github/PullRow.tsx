import "../../i18n/register-github.ts";
import type { PullView } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { CheckChip } from "./CheckChip.tsx";
import { CheckLog } from "./CheckLog.tsx";
import { type SendSource, sourceKey } from "./use-send-to-session.ts";

interface Props {
  readonly projectId: string;
  readonly pull: PullView;
  /** The source being sent and when it started, for the button that spins. */
  readonly sending: string | null;
  readonly since: number | null;
  onSend(source: SendSource): void;
}

/** A pull request as a muted row of plain text (title, author), its checks as chips, a failed check's log on demand. */
export function PullRow({ projectId, pull, sending, since, onSend }: Props) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <li className="flex min-w-0 flex-col gap-s1 border-b border-border py-s2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-s2 text-ui text-muted">
        <span className="font-mono tabular-nums">{`#${pull.number}`}</span>
        <span className="min-w-0 break-words">{pull.title}</span>
        <span>{t("github.by", { author: pull.author })}</span>
        {pull.draft ? <Chip tone="mut" label={t("github.draft")} /> : null}
      </div>
      <ul className="flex flex-col gap-s1">
        {pull.checks.map((check) => {
          const source: SendSource = { kind: "check", checkId: check.id };
          const shown = open === check.id;
          return (
            <li key={check.id} className="flex min-w-0 flex-col gap-s1">
              <div className="flex min-w-0 flex-wrap items-center gap-s2 text-ui text-muted">
                <CheckChip state={check.state} />
                <span className="min-w-0 break-words">{check.name}</span>
                {check.state === "failure" ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={shown}
                      onClick={() => setOpen(shown ? null : check.id)}
                    >
                      {t(shown ? "github.log.hide" : "github.log.show")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={since !== null}
                      pendingSince={sending === sourceKey(source) ? since : null}
                      onClick={() => onSend(source)}
                    >
                      {t("github.sendToSession")}
                    </Button>
                  </>
                ) : null}
              </div>
              {shown ? <CheckLog projectId={projectId} checkId={check.id} /> : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}
