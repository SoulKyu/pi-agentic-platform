import type { AuditView } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import { useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import {
  ARGS_POINTS,
  clipPoints,
  decisionTone,
  isGap,
  NAMES_POINTS,
  REASON_POINTS,
  resultDetail,
  sessionDetail,
  stageLine,
  timeOf,
} from "./audit.vm.ts";

const MUTED = "text-ui text-muted";
const ID_POINTS = 64;

/** Worker, model and client text: stripped and clipped here, drawn as React text, never as markup. */
function ClippedText({
  raw,
  max,
  marker,
  prefix,
  block,
}: {
  raw: string;
  max: number;
  marker: string;
  prefix?: string;
  block?: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const view = clipPoints(raw, max);
  const shown = `${prefix ?? ""}${expanded ? view.full : view.text}`;
  return (
    <>
      {block ? (
        <pre
          data-audit-text={marker}
          tabIndex={0}
          role="region"
          aria-label={t("audit.argsLabel")}
          className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-surface p-s2 font-mono text-ui text-fg"
        >
          {shown}
        </pre>
      ) : (
        <span data-audit-text={marker} className="min-w-0 break-words text-ui text-fg">
          {shown}
        </span>
      )}
      {view.clipped ? (
        <div>
          <Button size="sm" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            {t(expanded ? "audit.less" : "audit.more")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SessionLines({ row }: { row: AuditView }) {
  const t = useT();
  const detail = sessionDetail(row.detail);
  const count = Math.max(detail.count, detail.names.length);
  return (
    <div className="flex flex-col gap-s1">
      <p className={MUTED}>
        {detail.mode === null ? t("audit.session.noMode") : t("audit.session.mode", { mode: detail.mode })}
      </p>
      <div className="flex flex-col items-start gap-s1">
        <ClippedText
          raw={t("audit.session.tools", { count, names: detail.names.join(", ") })}
          max={NAMES_POINTS}
          marker="tools"
        />
        {detail.truncated ? <p className={MUTED}>{t("audit.session.truncated")}</p> : null}
      </div>
    </div>
  );
}

function ResultLine({ row }: { row: AuditView }) {
  const t = useT();
  const { redactions, external } = resultDetail(row.detail);
  return (
    <p className={MUTED}>
      {t("audit.result.redactions", { count: redactions })}
      {external ? ` · ${t("audit.result.external")}` : ""}
    </p>
  );
}

function Details({ row }: { row: AuditView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const withReason = row.stages.filter((verdict) => verdict.reason !== undefined && verdict.reason !== "");
  if (withReason.length === 0 && row.toolCallId === null) return null;
  return (
    <div className="flex flex-col items-start gap-s1">
      <Button size="sm" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        {t("audit.details")}
      </Button>
      {open ? (
        <ul className="flex flex-col gap-s1">
          {withReason.map((verdict) => (
            <li key={verdict.stage} className="flex flex-col items-start gap-s1">
              <ClippedText
                raw={verdict.reason ?? ""}
                max={REASON_POINTS}
                marker="stage-reason"
                prefix={`${verdict.stage} ${verdict.outcome}: `}
              />
            </li>
          ))}
          {row.toolCallId === null ? null : (
            <li className={MUTED}>{t("audit.callId", { id: clipPoints(row.toolCallId, ID_POINTS).text })}</li>
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** One audit row. `kind` and `decision` come from the daemon; every other text is clipped and drawn as text. */
export function AuditRow({ row }: { row: AuditView }) {
  const t = useT();
  const locale = useLocale();
  const time = timeOf(row.at, locale);
  const session = row.sessionId === null ? "" : clipPoints(row.sessionId, ID_POINTS).text;
  if (isGap(row)) {
    return (
      <li
        data-audit-row={row.id}
        data-audit-gap=""
        className="flex flex-col gap-s1 rounded-sm border border-dashed border-attn p-s2"
      >
        <div className="flex items-baseline gap-s2">
          <span data-audit-time className="font-mono text-label text-muted">
            {time}
          </span>
          <span className="break-all font-mono text-label text-muted">{session}</span>
        </div>
        <p className="text-ui text-attn">{t("audit.gap")}</p>
      </li>
    );
  }
  const who =
    row.actor === "worker"
      ? ""
      : [row.actor, row.actorId === null ? "" : clipPoints(row.actorId, ID_POINTS).text]
          .filter(Boolean)
          .join(" · ");
  const tool = row.tool === null ? "" : clipPoints(row.tool, ID_POINTS).text;
  return (
    <li data-audit-row={row.id} className="flex flex-col gap-s1 border-b border-border py-s2">
      <div className="flex flex-wrap items-center gap-s2">
        <span data-audit-time className="font-mono text-label text-muted">
          {time}
        </span>
        <span className="text-ui font-semibold text-fg">{t(`audit.kind.${row.kind}`)}</span>
        {tool ? (
          <span data-audit-tool className="font-mono text-ui text-fg">
            {tool}
          </span>
        ) : null}
        <Chip tone={decisionTone(row.decision)} label={t(`audit.decision.${row.decision}`)} />
        {who ? <span className="font-mono text-label text-muted">{who}</span> : null}
        {session ? <span className="break-all font-mono text-label text-muted">{session}</span> : null}
      </div>
      {row.reason ? (
        <div className="flex flex-col items-start gap-s1">
          <ClippedText raw={row.reason} max={REASON_POINTS} marker="reason" />
        </div>
      ) : null}
      {row.stages.length > 0 ? (
        <p data-audit-stages className="font-mono text-label text-muted">
          {stageLine(row.stages)}
        </p>
      ) : null}
      {row.kind === "session" ? <SessionLines row={row} /> : null}
      {row.kind === "result" ? <ResultLine row={row} /> : null}
      {row.args ? (
        <div className="flex flex-col items-start gap-s1">
          <ClippedText raw={row.args} max={ARGS_POINTS} marker="args" block />
        </div>
      ) : null}
      <Details row={row} />
    </li>
  );
}
