import "./register-space-catalog.ts";
import type { AgentSummary, AgentView } from "@pap/contracts";
import {
  Button,
  Chip,
  formatCost,
  IconButton,
  IconMore,
  InlineError,
  Segmented,
  type AvatarStyle,
} from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import type { ReactNode } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import type { Lifecycle } from "./agent-lifecycle.ts";
import { LifecycleChip } from "./LifecycleChip.tsx";
import { AgentAvatar } from "./AgentAvatar.tsx";

export type AgentTab = "thread" | "files" | "settings";

export interface AgentHeaderProps {
  readonly agent: AgentSummary;
  /** The agent in full (`agents.get`): the role and the model. Null until it is read. */
  readonly view: AgentView | null;
  readonly avatarStyle: AvatarStyle;
  /** The agent's lifecycle (`useAgentLifecycle`); null is ready, which shows no pill. */
  readonly lifecycle: Lifecycle | null;
  /** The thread's current taint (W5-R38). */
  readonly tainted: boolean;
  /** What the agent spent today in dollars (`agents.status`); null until it is read, or when it cannot be. */
  readonly costToday?: number | null;
  /** A pause or resume is in flight. */
  readonly pausing: number | null;
  /** The thread can be reset (it exists and the agent is not quarantined). */
  readonly canReset: boolean;
  /** What a failed action says, in words. */
  readonly problem: string | null;
  /** The reset confirmation, when it is asked. */
  readonly confirm: ReactNode;
  /** The status panel's toggle (M11R125): it is there whatever the setting says. */
  readonly statusToggle?: { readonly open: boolean; onToggle(): void };
  /** Thread / Files / Settings (M11R126): the agent's own settings sit beside its thread. */
  readonly tab?: { readonly value: AgentTab; readonly files?: boolean; onChange(tab: AgentTab): void };
  /** Opens the Queue task dialog (Task 23); without it the button waits, disabled. */
  onQueueTask?(): void;
  onTogglePause(): void;
  onReset(): void;
  /** Opens this agent's own Settings tab. */
  onOpenSettings(): void;
  onQuarantine(): void;
  onDelete(): void;
}

const firstLine = (role: string): string =>
  role
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? "";

/**
 * The agent tab's header (M11R118, decision 85): who it is, what it does and how it is, then every action in view or in
 * the menu. Quarantine and Delete open their dialogs (Task 25).
 */
export function AgentHeader(props: AgentHeaderProps) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const { agent, view } = props;
  const input = view?.input ?? null;
  const role = input === null ? "" : firstLine(input.role);
  const model =
    input === null
      ? null
      : input.model === null
        ? t("agentSpace.header.defaultModel")
        : `${input.model.provider} / ${input.model.modelId}`;
  // A quarantine is cleared from the Settings tab (password step-up): the disabled Resume says so (W5-R58).
  const resumeElsewhere = agent.quarantined && agent.paused;
  const items: MenuItem[] = [
    { id: "reset", label: t("agentSpace.menu.reset"), disabled: !props.canReset, onSelect: props.onReset },
    { id: "settings", label: t("agentSpace.menu.settings"), onSelect: props.onOpenSettings },
    {
      id: "quarantine",
      label: t("agentSpace.menu.quarantine"),
      disabled: agent.quarantined,
      onSelect: props.onQuarantine,
    },
    { id: "delete", label: t("agentSpace.menu.delete"), tone: "danger", onSelect: props.onDelete },
  ];
  return (
    <div data-agent-header="" className="flex flex-col gap-s2">
      <header className="flex flex-wrap items-center gap-s3">
        <AgentAvatar agent={agent} avatarStyle={props.avatarStyle} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-s2">
            <h2 className="min-w-0 truncate text-h2 text-fg">{agent.name}</h2>
            {props.lifecycle === null ? null : <LifecycleChip lifecycle={props.lifecycle} />}
            {props.tainted ? <Chip tone="ext" label={t("agentSpace.header.external")} /> : null}
          </div>
          {input === null ? null : (
            <p className="min-w-0 truncate text-ui text-muted">
              {role === "" ? t("agentSpace.header.noRole") : role}
              {model === null ? null : <span className="font-mono text-label"> · {model}</span>}
              {props.costToday == null ? null : (
                <span className="text-label">
                  {" "}
                  · {t("agentSpace.header.costToday", { cost: formatCost(props.costToday) })}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-s2">
          {props.tab === undefined ? null : (
            <Segmented
              label={t("agentSafety.tab.label")}
              value={props.tab.value}
              options={[
                { value: "thread", label: t("agentSafety.tab.thread") },
                ...(props.tab.files === true
                  ? [{ value: "files" as const, label: t("agentFiles.tab") }]
                  : []),
                { value: "settings", label: t("agentSafety.tab.settings") },
              ]}
              onChange={props.tab.onChange}
            />
          )}
          {props.statusToggle === undefined ? null : (
            <Button
              variant="ghost"
              aria-pressed={props.statusToggle.open}
              onClick={props.statusToggle.onToggle}
            >
              {t("agentStatus.toggle")}
            </Button>
          )}
          <Button disabled={agent.quarantined || props.onQueueTask === undefined} onClick={props.onQueueTask}>
            {t("agentSpace.header.queue")}
          </Button>
          <Button
            disabled={agent.quarantined}
            pendingSince={props.pausing}
            aria-describedby={resumeElsewhere ? "agent-resume-hint" : undefined}
            onClick={props.onTogglePause}
          >
            {t(agent.paused ? "agentSpace.header.resume" : "agentSpace.header.pause")}
          </Button>
          {resumeElsewhere ? (
            <span id="agent-resume-hint" className="text-ui text-muted">
              {t("agentSpace.header.resumeHint")}
            </span>
          ) : null}
          <LazyMenu
            label={t("agentSpace.header.more")}
            closeLabel={t("ui.close")}
            text={lazyText}
            items={items}
            trigger={(ask) => (
              <IconButton icon={IconMore} label={t("agentSpace.header.more")} onClick={ask} />
            )}
          />
        </div>
      </header>
      {props.problem === null ? null : <InlineError announce="action">{props.problem}</InlineError>}
      {props.confirm}
    </div>
  );
}
