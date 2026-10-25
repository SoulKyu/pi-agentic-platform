import "./register-lanes-catalog.ts";
import { Button, Chip, IconButton, IconMore, Tooltip, useIsPhone } from "@pap/ui";
import { Menu } from "@pap/ui/overlays";
import type { ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { CheckCount } from "./CheckCount.tsx";
import { PrError } from "./PrError.tsx";
import type { HeaderModel, PrBadge } from "./lane-header.vm.ts";

export interface HeaderActions {
  onSetupLog(): void;
  onRunSetup(): void;
  onNewSession(): void;
  onArchive(): void;
  onRetryPr(): void;
  /** The fan-out's compare tab (§5); null for a lane outside a fan-out. */
  readonly onOpenCompare: (() => void) | null;
}

interface Props {
  readonly title: string;
  readonly model: HeaderModel;
  readonly actions: HeaderActions;
  readonly busy: { readonly runSetup: boolean; readonly newSession: boolean };
  /** The session picker; the screen decides whether there is anything to pick. */
  readonly sessionMenu: ReactNode;
}

function Pr({ pr, onRetry, compact }: { readonly pr: PrBadge; onRetry(): void; readonly compact: boolean }) {
  const t = useT();
  const label = `#${pr.number}${pr.state === null || compact ? "" : ` · ${t(pr.state)}`}`;
  return (
    <span className="flex flex-wrap items-center gap-s2 font-mono text-code tabular-nums text-muted">
      {pr.href !== null ? (
        <a
          href={pr.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("lanes.pr.link", { number: pr.number })}
          className="text-you-text underline focus-ring"
        >
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
      {compact
        ? null
        : pr.checks.map((check) => <CheckCount key={check.kind} kind={check.kind} count={check.count} />)}
      {pr.conflicts && !compact ? <span className="text-attn">{t("lanes.pr.conflicts")}</span> : null}
      {pr.error !== null && !compact ? (
        <>
          <PrError message={pr.error} />
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {t("lanes.pr.retry")}
          </Button>
        </>
      ) : null}
    </span>
  );
}

/**
 * The lane's header (board 10 §1): title, status chip and reason, the facts line, the pull request, the actions.
 * On a phone it shrinks to `branch · status · ↑n · PR` and the actions go to a sheet (M9R67).
 */
export function LaneHeader({ title, model, actions, busy, sessionMenu }: Props) {
  const t = useT();
  const phone = useIsPhone();
  const status = (
    <>
      <Chip tone={model.tone} label={t(`shell.lane.status.${model.status}`)} />
      {model.reason !== null && !phone ? <span className="text-ui text-muted">{t(model.reason)}</span> : null}
    </>
  );
  const items = [
    ...(actions.onOpenCompare !== null
      ? [{ id: "compare", label: t("lanes.action.compare"), onSelect: actions.onOpenCompare }]
      : []),
    { id: "log", label: t("lanes.action.setupLog"), onSelect: actions.onSetupLog },
    ...(model.runSetup
      ? [
          {
            id: "run",
            label: t("lanes.action.runSetup"),
            onSelect: actions.onRunSetup,
            disabled: busy.runSetup,
          },
        ]
      : []),
    {
      id: "new",
      label: t("lanes.action.newSession"),
      onSelect: actions.onNewSession,
      disabled: busy.newSession,
    },
    { id: "archive", label: t("lanes.action.archive"), onSelect: actions.onArchive, tone: "danger" as const },
  ];

  if (phone) {
    return (
      <header className="flex items-center gap-s2 border-b border-border px-s3 py-s2">
        <span className="min-w-0 flex-1 truncate font-mono text-code text-fg">{model.facts.branch}</span>
        {status}
        <span className="font-mono text-code tabular-nums text-muted">{`↑${model.facts.ahead}`}</span>
        {model.pr !== null ? <Pr pr={model.pr} onRetry={actions.onRetryPr} compact /> : null}
        <Menu
          label={t("lanes.action.more")}
          closeLabel={t("lanes.action.close")}
          trigger={<IconButton icon={IconMore} label={t("lanes.action.more")} />}
          items={items}
        />
      </header>
    );
  }
  return (
    <header className="flex flex-col gap-s2 border-b border-border px-s4 py-s2">
      <div className="flex flex-wrap items-center gap-s2">
        <h1 className="min-w-0 truncate text-ui font-semibold text-fg">{title}</h1>
        {status}
        {model.external ? <Chip tone="ext" label={t("lanes.external")} /> : null}
        {sessionMenu}
      </div>
      <div className="flex flex-wrap items-center gap-s3">
        <p
          aria-label={t("lanes.facts.label")}
          className="min-w-0 truncate font-mono text-code tabular-nums text-muted"
        >
          {`${model.facts.branch} → ${model.facts.base}`}
          {" · "}
          {`↑${model.facts.ahead} ↓${model.facts.behind}`}
          {" · "}
          {`+${model.facts.additions} −${model.facts.deletions}`}
        </p>
        {model.pr !== null ? <Pr pr={model.pr} onRetry={actions.onRetryPr} compact={false} /> : null}
        {model.note === null ? null : (
          <Tooltip label={model.note}>
            <p tabIndex={0} className="min-w-0 truncate text-ui text-muted">
              <span className="font-semibold">{t("lanes.note.from")}</span> {model.note}
            </p>
          </Tooltip>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-s2">
          {actions.onOpenCompare !== null ? (
            <Button size="sm" onClick={actions.onOpenCompare}>
              {t("lanes.action.compare")}
            </Button>
          ) : null}
          <Button size="sm" onClick={actions.onSetupLog}>
            {t("lanes.action.setupLog")}
          </Button>
          {model.runSetup && model.byToken ? (
            <span className="text-ui text-attn">{t("lanes.setup.byToken")}</span>
          ) : null}
          {model.runSetup ? (
            <Button size="sm" variant="primary" disabled={busy.runSetup} onClick={actions.onRunSetup}>
              {t("lanes.action.runSetup")}
            </Button>
          ) : null}
          <Button size="sm" disabled={busy.newSession} onClick={actions.onNewSession}>
            {t("lanes.action.newSession")}
          </Button>
          <Button size="sm" onClick={actions.onArchive}>
            {t("lanes.action.archive")}
          </Button>
        </span>
      </div>
    </header>
  );
}
