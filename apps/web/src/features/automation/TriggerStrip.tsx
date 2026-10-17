import type { TaskTrigger } from "@pap/contracts";
import { Button, Chip, Switch } from "@pap/ui";
import { useState } from "react";
import { useT, type MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { shown } from "./board.vm.ts";

const GLYPH: Record<TaskTrigger["sourceType"], string> = {
  schedule: "⏱",
  webhook: "⇢",
  feed: "◉",
  manual: "",
};
const SOURCE_KEY: Record<TaskTrigger["sourceType"], MessageKey> = {
  schedule: "automation.trigger.source.schedule",
  webhook: "automation.trigger.source.webhook",
  feed: "automation.trigger.source.feed",
  manual: "automation.trigger.source.manual",
};

interface TriggerStripProps {
  readonly triggers: readonly TaskTrigger[];
  /** The column's scope for "New trigger": a project id, or `agent:<id>` in an agent's column. Null: no button. */
  readonly projectId: string | null;
  readonly projectName: string;
  onOpenTrigger(triggerId: string): void;
  onNewTrigger(projectId: string): void;
}

/** The triggers of one column (owner m10q2): glyph and source chip, an enabled Switch, Edit, and "New trigger" for the project. */
export function TriggerStrip({
  triggers,
  projectId,
  projectName,
  onOpenTrigger,
  onNewTrigger,
}: TriggerStripProps) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const setEnabled = (trigger: TaskTrigger, enabled: boolean) => {
    if (busy !== null) return;
    setBusy(trigger.id);
    setFailed(null);
    const rpc = getRuntime().rpc;
    rpc
      .call(
        "automation.triggers.setEnabled",
        { triggerId: trigger.id, enabled },
        { commandId: rpc.newCommandId() },
      )
      .catch(() => setFailed(trigger.id))
      .finally(() => setBusy(null));
  };

  return (
    <section
      data-slot="trigger-strip"
      aria-label={t("automation.strip.label", { project: projectName })}
      className="flex flex-col gap-s2 border-b border-border px-s3 py-s2"
    >
      <ul className="flex flex-col gap-s2">
        {triggers.map((trigger) => {
          const name = shown(trigger.name, "name");
          return (
            <li key={trigger.id} className="flex flex-col gap-s1">
              <div className="flex flex-wrap items-center gap-s2">
                <span aria-hidden className="text-ui text-muted">
                  {GLYPH[trigger.sourceType]}
                </span>
                <Chip
                  tone={trigger.sourceType === "webhook" ? "ext" : "mut"}
                  label={t(SOURCE_KEY[trigger.sourceType])}
                />
                {trigger.state === "ok" ? null : (
                  <Chip tone="err" label={t(`automation.trigger.state.${trigger.state}`)} />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("automation.trigger.editLabel", { name })}
                  onClick={() => onOpenTrigger(trigger.id)}
                >
                  {t("automation.trigger.edit")}
                </Button>
              </div>
              <Switch
                label={name}
                checked={trigger.enabled}
                disabled={busy !== null}
                onChange={(next) => setEnabled(trigger, next)}
              />
              {failed === trigger.id ? (
                <p role="alert" className="text-ui text-err">
                  {t("automation.trigger.toggleFailed", { name })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {projectId === null ? null : (
        <div>
          <Button size="sm" variant="secondary" onClick={() => onNewTrigger(projectId)}>
            {t("automation.trigger.new")}
          </Button>
        </div>
      )}
    </section>
  );
}
