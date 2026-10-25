import { Button, Chip, InlineError, Switch, TextField, Tooltip, useIsPhone } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { EditorStatus } from "./use-trigger-editor.ts";
import type { Draft } from "./editor.vm.ts";

interface EditorHeaderProps {
  readonly draft: Draft;
  set(patch: Partial<Draft>): void;
  readonly nameError: string | null;
  readonly canFire: boolean;
  readonly canSave: boolean;
  readonly since: number | null;
  readonly status: EditorStatus | null;
  onFire(): void;
  onSave(): void;
}

/** Name, enabled, "Fire now" (the saved trigger, so never with unsaved changes) and "Save" (board 11 §1, top left). */
export function EditorHeader({
  draft,
  set,
  nameError,
  canFire,
  canSave,
  since,
  status,
  onFire,
  onSave,
}: EditorHeaderProps) {
  const t = useT();
  const phone = useIsPhone();
  const idle = since === null;
  const fire = (
    <Button disabled={!canFire || !idle} onClick={onFire}>
      {t("automation.editor.fireNow")}
    </Button>
  );
  return (
    <header className="flex flex-col gap-s2">
      <div className="flex flex-wrap items-end gap-s3">
        <div className={phone ? "min-w-0 flex-1" : "min-w-pane flex-1"}>
          <TextField
            label={t("automation.editor.name")}
            value={draft.name}
            error={nameError}
            onChange={(name) => set({ name })}
          />
        </div>
        <Chip
          tone={draft.sourceType === "webhook" || draft.sourceType === "feed" ? "ext" : "mut"}
          label={t(`automation.trigger.source.${draft.sourceType}`)}
        />
        <Switch
          label={t("automation.editor.enabled")}
          checked={draft.enabled}
          onChange={(enabled) => set({ enabled })}
        />
        {canFire ? (
          fire
        ) : (
          <Tooltip label={t("automation.editor.saveFirst")}>
            <span tabIndex={0} className="inline-flex focus-ring">
              {fire}
            </span>
          </Tooltip>
        )}
        <Button variant="primary" disabled={!canSave} pendingSince={since} onClick={onSave}>
          {t("automation.editor.save")}
        </Button>
      </div>
      {status === null ? null : status.tone === "err" ? (
        <InlineError announce="action">{status.text}</InlineError>
      ) : (
        <p role="status" className="text-ui text-muted">
          {status.text}
        </p>
      )}
    </header>
  );
}
