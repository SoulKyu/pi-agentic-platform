import "./register-space-catalog.ts";
import type { AgentSummary } from "@pap/contracts";
import { Button, Chip, formatCost, Meter, usePendingAction } from "@pap/ui";
import { useState, type ReactNode } from "react";
import { errorKey, useLocale, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import {
  ago,
  budgetVm,
  taskRows,
  triggerRows,
  type BudgetVm,
  type PanelLayout,
  type TaskRowVm,
  type TriggerRowVm,
} from "./status.vm.ts";
import { papText } from "../../i18n/pap-text.ts";
import { ExtensionOverrideNote } from "./ExtensionOverrideNote.tsx";
import { LifecycleChip } from "./LifecycleChip.tsx";
import { useAgentLifecycle } from "./use-agent-lifecycle.ts";
import { useAgentStatus } from "./use-agent-status.ts";
import { useNow } from "./use-agent-space.ts";
import { agentById } from "../../stores/agents-reducer.ts";
import { useAgents } from "../../stores/agents-store.ts";

/** How often "5 minutes ago" is written again: a local clock, nothing is asked of the daemon. */
const RECENCY_TICK_MS = 60_000;

export interface StatusPanelProps {
  readonly agentId: string;
  readonly layout: PanelLayout;
  /** Hides the panel (the column) or goes back to the thread (the pane). The sheet closes itself. */
  readonly closeLabel?: string;
  onClose?(): void;
  /** Opens Settings › Agents, where the agent's budget is (Task 25 narrows it to the agent). */
  onOpenSettings(): void;
  onOpenSession(sessionId: string): void;
  onOpenTrigger(triggerId: string): void;
  /** Opens the trigger editor prefilled with this agent. */
  onNewTrigger(): void;
}

/**
 * The agent tab's status panel (M11R125, board 09 option 1): today's budget, the 7 d and 30 d cost, the newest tasks and
 * the triggers. Mounted only while shown; it reads `agents.status` on open and again after the streams say something
 * about this agent, never on a timer.
 */
export function StatusPanel(props: StatusPanelProps) {
  const t = useT();
  const { load, retry } = useAgentStatus(props.agentId);
  return (
    <section
      data-status-panel={props.layout}
      aria-label={t("agentStatus.title")}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-s4 overflow-y-auto p-s3"
    >
      <header className="flex items-center justify-between gap-s2">
        <h2 className="min-w-0 flex-1 text-h2 text-fg">{t("agentStatus.title")}</h2>
        <PanelLifecycle agentId={props.agentId} />
        {props.onClose === undefined || props.closeLabel === undefined ? null : (
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            {props.closeLabel}
          </Button>
        )}
      </header>
      <PanelExtensionOverride agentId={props.agentId} />
      {load.kind === "loading" ? (
        <p role="status" className="text-ui text-muted">
          {t("agentStatus.loading")}
        </p>
      ) : null}
      {load.kind === "failed" ? (
        <div className="flex flex-col items-start gap-s2">
          <p role="alert" className="text-ui text-attn">
            {t("agentStatus.failed")}
          </p>
          <Button onClick={retry}>{t("agentStatus.retry")}</Button>
        </div>
      ) : null}
      {load.kind === "ready" && load.refreshFailed ? (
        <div className="flex flex-wrap items-center gap-s2">
          <p role="alert" className="text-ui text-attn">
            {t("agentStatus.refreshFailed")}
          </p>
          <Button size="sm" onClick={retry}>
            {t("agentStatus.retry")}
          </Button>
        </div>
      ) : null}
      {load.kind === "ready" ? <Body {...props} status={load.status} /> : null}
    </section>
  );
}

/** The same chip as the header's, so the panel never words the agent's state its own way. */
function PanelLifecycle({ agentId }: { readonly agentId: string }) {
  const agent = useAgents((view) => agentById(view, agentId));
  if (agent === undefined) return null;
  return <PanelChip agent={agent} />;
}

function PanelExtensionOverride({ agentId }: { readonly agentId: string }) {
  const agent = useAgents((view) => agentById(view, agentId));
  return <ExtensionOverrideNote sessionId={agent?.threadSessionId ?? null} />;
}

function PanelChip({ agent }: { readonly agent: AgentSummary }) {
  const lifecycle = useAgentLifecycle(agent, agent.threadSessionId);
  return lifecycle === null ? null : <LifecycleChip lifecycle={lifecycle} />;
}

type Status = Extract<ReturnType<typeof useAgentStatus>["load"], { kind: "ready" }>["status"];

function Body(props: StatusPanelProps & { readonly status: Status }) {
  const t = useT();
  const locale = useLocale();
  const { status } = props;
  const now = useNow(RECENCY_TICK_MS);
  const billing =
    status.billing === "api" ? null : (
      <span className="font-mono text-label text-muted">
        {t(
          status.billing === "subscription"
            ? "agentStatus.billing.subscription"
            : "agentStatus.billing.unknown",
        )}
      </span>
    );
  return (
    <>
      <Block title={t("agentStatus.budget")}>
        <BudgetBlock budget={budgetVm(status.today)} onOpenSettings={props.onOpenSettings} />
      </Block>
      <Block title={t("agentStatus.cost")} extra={billing}>
        <dl className="grid grid-cols-2 gap-s2 text-ui">
          <div className="flex flex-col">
            <dt className="label-hud text-muted">{t("agentStatus.cost.days7")}</dt>
            <dd className="font-mono tabular-nums text-fg">{formatCost(status.days7Usd)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="label-hud text-muted">{t("agentStatus.cost.days30")}</dt>
            <dd className="font-mono tabular-nums text-fg">{formatCost(status.days30Usd)}</dd>
          </div>
        </dl>
      </Block>
      <Block title={t("agentStatus.tasks")}>
        {status.tasks.length === 0 ? (
          <p className="text-ui text-muted">{t("agentStatus.tasks.none")}</p>
        ) : (
          <ul className="flex flex-col gap-s2">
            {taskRows(status.tasks).map((row) => (
              <TaskRow key={row.id} row={row} when={ago(now, row.at, locale)} onOpen={props.onOpenSession} />
            ))}
          </ul>
        )}
      </Block>
      <Block title={t("agentStatus.triggers")}>
        {status.triggers.length === 0 ? (
          <p className="text-ui text-muted">{t("agentStatus.triggers.none")}</p>
        ) : (
          <ul className="flex flex-col gap-s2">
            {triggerRows(status.triggers).map((row) => (
              <TriggerRow key={row.id} row={row} onEdit={props.onOpenTrigger} />
            ))}
          </ul>
        )}
        <div>
          <Button size="sm" onClick={props.onNewTrigger}>
            {t("agentStatus.triggers.new")}
          </Button>
        </div>
      </Block>
      {status.truncated ? <p className="text-ui text-muted">{t("agentStatus.truncated")}</p> : null}
    </>
  );
}

function Block({
  title,
  extra,
  children,
}: {
  readonly title: string;
  readonly extra?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-s2">
      <div className="flex items-baseline justify-between gap-s2">
        <h3 className="label-hud text-muted">{title}</h3>
        {extra}
      </div>
      {children}
    </div>
  );
}

function BudgetBlock({ budget, onOpenSettings }: { readonly budget: BudgetVm; onOpenSettings(): void }) {
  const t = useT();
  if (budget.kind === "none")
    return (
      <div className="flex flex-col items-start gap-s1">
        <p className="text-ui text-muted">{t("agentStatus.budget.none")}</p>
        <p className="font-mono text-ui tabular-nums text-fg">
          {t("agentStatus.budget.spent", { amount: budget.spent })}
        </p>
        <Button size="sm" variant="ghost" onClick={onOpenSettings}>
          {t("agentStatus.budget.set")}
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-s2">
      {budget.meters.map((meter) => (
        <Meter
          key={meter.kind}
          kind={meter.kind}
          label={t(meter.kind === "tokens" ? "agentStatus.budget.tokens" : "agentStatus.budget.cost")}
          value={meter.value}
          max={meter.max}
          valueText={meter.valueText}
        />
      ))}
      {budget.over ? (
        <div>
          <Chip tone="att" dot label={t("agentStatus.budget.over")} />
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({
  row,
  when,
  onOpen,
}: {
  readonly row: TaskRowVm;
  readonly when: string;
  onOpen(sessionId: string): void;
}) {
  const t = useT();
  const sessionId = row.sessionId;
  return (
    <li className="flex items-center gap-s2">
      <Chip tone={row.tone} label={t(`agentStatus.state.${row.stateWord}`)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-fg">{papText(t, row.title)}</span>
        <span className="block text-label text-muted">{when}</span>
      </span>
      {sessionId === null ? null : (
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("agentStatus.tasks.open.label", { title: papText(t, row.title) })}
          onClick={() => onOpen(sessionId)}
        >
          {t("agentStatus.tasks.open")}
        </Button>
      )}
    </li>
  );
}

type FireNote = { readonly tone: "ok" | "err" | "info"; readonly text: string };

/** The note under a row clears only when the same row is run again (or the panel closes): no timer. */
function TriggerRow({ row, onEdit }: { readonly row: TriggerRowVm; onEdit(triggerId: string): void }) {
  const t = useT();
  const pending = usePendingAction();
  const [note, setNote] = useState<FireNote | null>(null);
  const fire = () =>
    void pending.run(async () => {
      setNote(null);
      try {
        const answer = await getRuntime().rpc.call(
          "automation.fire",
          { triggerId: row.id },
          { commandId: getRuntime().rpc.newCommandId() },
        );
        if (answer.verdict === "fired") setNote({ tone: "ok", text: t("agentStatus.triggers.fired") });
        else if (answer.verdict === "precheck")
          setNote({ tone: "info", text: t("agentStatus.triggers.fireSkipped", { detail: answer.detail }) });
        else setNote({ tone: "err", text: t("agentStatus.triggers.fireFailed") });
      } catch (cause) {
        setNote({ tone: "err", text: t(errorKey(cause instanceof RpcError ? cause.code : "internal")) });
      }
    });
  return (
    <li className="flex flex-col gap-s1">
      <div className="flex items-center gap-s2">
        <span aria-hidden className="text-ui text-muted">
          {row.glyph}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-fg">{row.name}</span>
        {row.enabled ? null : <Chip tone="mut" label={t("agentStatus.triggers.off")} />}
        {row.canFire ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending.since !== null}
            aria-label={t("agentStatus.triggers.fire.label", { name: row.name })}
            onClick={fire}
          >
            {t("agentStatus.triggers.fire")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("agentStatus.triggers.edit.label", { name: row.name })}
          onClick={() => onEdit(row.id)}
        >
          {t("agentStatus.triggers.edit")}
        </Button>
      </div>
      {note === null ? null : (
        <p
          role={note.tone === "err" ? "alert" : "status"}
          className={`text-label ${note.tone === "err" ? "text-err" : note.tone === "ok" ? "text-ok" : "text-muted"}`}
        >
          {note.text}
        </p>
      )}
    </li>
  );
}
