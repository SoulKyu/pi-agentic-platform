import "./register-agent-catalog.ts";
import { type AgentSummary, type ToolPreset } from "@pap/contracts";
import { Banner, Button, InlineError, toast } from "@pap/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { AgentForm } from "./AgentForm.tsx";
import { useAgentView } from "./use-agent-view.ts";

interface Props {
  readonly agentId: string;
  /** The stream's word on this agent: when it moves, the agent is read again. */
  readonly summary: AgentSummary | undefined;
  presetField(value: ToolPreset, onChange: (preset: ToolPreset) => void): ReactNode;
  /** The list this view came from (Settings › Agents); the agent's own tab has none. */
  onBack?(): void;
  /** The group to land on once the agent has loaded (the status panel's "Set a budget"); the heading otherwise. */
  readonly focus?: "budget";
  /** More sections below the form (the agent's tab: permissions, secrets, actions). Shown for an unreadable profile too. */
  readonly after?: ReactNode;
}

/** One agent's settings (M11R97): the form of Task 15 over the agent as `agents.get` reads it. */
export function AgentSettingsView({ agentId, summary, presetField, onBack, focus, after }: Props) {
  const t = useT();
  const stamp = `${summary?.lastActivityAt ?? 0}:${summary?.name ?? ""}:${summary?.state ?? ""}`;
  const { load, reload, set } = useAgentView(agentId, stamp);
  // Host state, not form state: it must outlive the re-key a newer revision causes.
  const [changed, setChanged] = useState(false);
  // The view just swapped in: focus follows to its heading once the agent has loaded (a11y).
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const ready = load.kind === "ready";
  // Once per agent and landing group: a reload that fails and recovers flips `ready` again, and must not take the focus
  // from wherever the owner has gone since.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const landing = `${agentId}:${focus ?? ""}`;
    if (focused.current === landing) return;
    focused.current = landing;
    const group =
      focus === "budget"
        ? root.current?.querySelector<HTMLElement>('[data-slot="agent-budget"] input')
        : null;
    (group ?? heading.current)?.focus();
  }, [ready, focus, agentId]);
  const readdAndNote = async () => {
    const before = load.kind === "ready" ? load.agent.revision : null;
    const fresh = await reload();
    if (fresh !== null && before !== null && fresh.revision !== before) setChanged(true);
    return fresh;
  };
  return (
    <div ref={root} className="flex flex-col gap-s3">
      {onBack === undefined ? null : (
        <div>
          <Button variant="ghost" onClick={onBack}>
            {t("settings.agents.back")}
          </Button>
        </div>
      )}
      {load.kind === "loading" ? (
        <p role="status" className="text-ui text-muted">
          {t("settings.agents.detail.loading", { name: summary?.name ?? "" })}
        </p>
      ) : load.kind === "gone" ? (
        <p role="status" className="text-ui text-muted">
          {t("settings.agents.detail.gone")}
        </p>
      ) : load.kind === "failed" ? (
        <InlineError announce="background">{t("settings.agents.detail.failed")}</InlineError>
      ) : (
        <>
          <h3 ref={heading} tabIndex={-1} className="text-h2 text-fg focus:outline-none">
            {load.agent.name}
          </h3>
          {changed ? (
            <InlineError announce="action">{t("settings.agents.changedElsewhere")}</InlineError>
          ) : null}
          {load.agent.input === null ? (
            <Banner tone="capacity" title={t("settings.agents.detail.unreadable")} />
          ) : (
            // A saved or remote edit changes the revision and starts the form again from the saved agent.
            <AgentForm
              key={`${load.agent.id}:${load.agent.revision}`}
              agent={load.agent}
              presetField={presetField}
              onReload={readdAndNote}
              onSaved={(saved) => {
                setChanged(false);
                set(saved);
                toast({ message: t("settings.agents.saved") });
              }}
            />
          )}
          {after}
        </>
      )}
    </div>
  );
}
