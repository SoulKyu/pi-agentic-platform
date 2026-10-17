import "../../i18n/register-subagents.ts";
import type { ChildView, SubagentState } from "@pap/contracts";
import { Button, Chip, type ChipTone, formatCost } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { cutUnits, stripHidden } from "../../lib/untrusted-text.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";

/** Past this many the bar shows a count that opens the list (M11R153). */
const COLLAPSE_PAST = 3;
/** A title is the model's text: this much of it, no more. */
const TITLE_UNITS = 80;

const TONE: Record<SubagentState, ChipTone> = {
  starting: "run",
  running: "run",
  done: "ok",
  failed: "err",
  cancelled: "mut",
  interrupted: "att",
};
const isLive = (state: SubagentState): boolean => state === "starting" || state === "running";

/** The title of a child as the screen shows it: hidden characters removed, clipped. Never inserted as HTML. */
export const titleOf = (child: ChildView): string => cutUnits(stripHidden(child.title), TITLE_UNITS);

/**
 * The subagents of this session, above its composer (M11R153): one chip per child with its title, profile, state and cost,
 * Open (a session tab) and, while it runs, Stop. Past three they fold into "N subagents".
 */
export function SubagentBar({
  sessionId,
  subagents,
}: {
  readonly sessionId: string;
  readonly subagents: readonly ChildView[];
}) {
  const t = useT();
  const locale = useLocale();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  if (subagents.length === 0) return null;
  const folded = subagents.length > COLLAPSE_PAST;
  const count = plural(locale, "subagents.bar.count", subagents.length);

  const stop = (runId: string) => {
    setFailed(false);
    setStopping((was) => new Set(was).add(runId));
    const rpc = getRuntime().rpc;
    void rpc.call("subagents.cancel", { runId }, { commandId: rpc.newCommandId() }).catch(() => {
      // Not stopped: the chip offers Stop again (a stopped one leaves by the stream's own event).
      setFailed(true);
      setStopping((was) => new Set([...was].filter((id) => id !== runId)));
    });
  };

  return (
    <section
      data-subagent-bar={sessionId}
      aria-label={t("subagents.bar.label")}
      className="flex flex-col gap-s1 border-l-2 border-agent px-s3 py-s2"
    >
      {folded ? (
        <div>
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
            {count}
          </Button>
        </div>
      ) : (
        <p className="label-hud text-muted">{count}</p>
      )}
      {!folded || open ? (
        <ul className="flex flex-col gap-s1">
          {subagents.map((child) => {
            const title = titleOf(child);
            return (
              <li key={child.id} data-subagent={child.id} className="flex flex-wrap items-center gap-s2">
                <span className="min-w-0 flex-1 truncate text-ui text-fg">{title}</span>
                {child.profile === null ? null : (
                  <span className="font-mono text-label text-muted">{child.profile}</span>
                )}
                <Chip tone={TONE[child.state]} label={t(`subagents.state.${child.state}`)} dot />
                <span className="font-mono text-label text-muted tabular-nums">
                  {formatCost(child.costUsd)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("subagents.openNamed", { title })}
                  onClick={() =>
                    void navigate({ to: "/s/$sessionId", params: { sessionId: child.id } }).catch(() =>
                      reportClientIssue("command_failed"),
                    )
                  }
                >
                  {t("subagents.open")}
                </Button>
                {isLive(child.state) ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={t("subagents.stopNamed", { title })}
                    disabled={stopping.has(child.runId)}
                    onClick={() => stop(child.runId)}
                  >
                    {t("subagents.stop")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {failed ? (
        <p role="alert" className="text-ui text-attn">
          {t("subagents.stopFailed")}
        </p>
      ) : null}
    </section>
  );
}
