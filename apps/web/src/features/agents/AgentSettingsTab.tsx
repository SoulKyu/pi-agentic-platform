import "./register-space-catalog.ts";
import type { AgentSummary, ToolPreset } from "@pap/contracts";
import { Button, InlineError, usePendingAction } from "@pap/ui";
import { type ReactNode, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { setPaused } from "./agent-actions.ts";
import { AgentSettingsView } from "./AgentSettingsView.tsx";
import { PermissionsSheet } from "./PermissionsSheet.tsx";
import { SecretsList } from "./SecretsList.tsx";
import { useAgentPermissions } from "./use-agent-permissions.ts";

export interface AgentSettingsTabProps {
  readonly agent: AgentSummary;
  /** The group to land on (the status panel's "Set a budget"). */
  readonly focus?: "budget";
  /** The thread can be reset (it exists and the agent is not quarantined). */
  readonly canReset: boolean;
  /** M7's tool preset picker, given by the host so this feature imports no other feature. */
  presetField(value: ToolPreset, onChange: (preset: ToolPreset) => void): ReactNode;
  onReset(): void;
  onQuarantine(): void;
  onDelete(): void;
}

/**
 * The agent's Settings tab (M11R126), beside its thread: the form of Task 15 (its daily budget included), the permissions
 * sheet, the secrets list, then Reset thread, Quarantine and Delete. The dialogs of the last two belong to the agent screen.
 */
export function AgentSettingsTab(props: AgentSettingsTabProps) {
  const t = useT();
  const { agent } = props;
  const stepUp = useStepUpRunner();
  const resuming = usePendingAction();
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const resume = () =>
    void resuming.run(async () => {
      setProblem(null);
      setProblem(await setPaused(agent.id, false, stepUp));
    });
  const permissions = useAgentPermissions(agent.id, `${agent.lastActivityAt}:${agent.name}:${agent.state}`);
  return (
    <div data-agent-settings="" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <AgentSettingsView
        agentId={agent.id}
        summary={agent}
        presetField={props.presetField}
        {...(props.focus === undefined ? {} : { focus: props.focus })}
        after={
          <div className="flex flex-col gap-s6 p-s3">
            {agent.unreadable ? null : permissions.kind === "ready" ? (
              <PermissionsSheet view={permissions.view} />
            ) : permissions.kind === "failed" ? (
              <InlineError announce="background">{t("agentSafety.perm.failed")}</InlineError>
            ) : (
              <p role="status" className="text-ui text-muted">
                {t("agentSafety.perm.loading")}
              </p>
            )}
            <SecretsList agentId={agent.id} />
            <section data-agent-actions="" className="flex flex-col gap-s3">
              <h3 className="text-h2 text-fg">{t("agentSafety.actions.title")}</h3>
              <Action
                label={t("agentSafety.actions.reset")}
                hint={t("agentSafety.actions.resetHint")}
                disabled={!props.canReset}
                onClick={props.onReset}
              />
              <Action
                label={t("agentSafety.actions.resume")}
                hint={t("agentSafety.actions.resumeHint")}
                disabled={!agent.quarantined}
                pendingSince={resuming.since}
                onClick={resume}
              />
              {problem === null ? null : <InlineError announce="action">{t(problem)}</InlineError>}
              <Action
                label={t("agentSafety.actions.quarantine")}
                hint={t("agentSafety.actions.quarantineHint")}
                disabled={agent.quarantined}
                onClick={props.onQuarantine}
              />
              <Action
                label={t("agentSafety.actions.delete")}
                hint={t("agentSafety.actions.deleteHint")}
                onClick={props.onDelete}
              />
            </section>
          </div>
        }
      />
    </div>
  );
}

function Action({
  label,
  hint,
  disabled,
  pendingSince,
  onClick,
}: {
  readonly label: string;
  readonly hint: string;
  readonly disabled?: boolean;
  readonly pendingSince?: number | null;
  onClick(): void;
}) {
  return (
    <div className="flex flex-col items-start gap-s1">
      <Button disabled={disabled === true} pendingSince={pendingSince ?? null} onClick={onClick}>
        {label}
      </Button>
      <p className="text-ui text-muted">{hint}</p>
    </div>
  );
}
