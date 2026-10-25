import type { TriggerView } from "@pap/contracts";
import { cn, useIsPhone } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { DryRunPanel } from "./DryRunPanel.tsx";
import { EditorHeader } from "./EditorHeader.tsx";
import type { Draft } from "./editor.vm.ts";
import { ExecutionSection } from "./ExecutionSection.tsx";
import { FireJournal } from "./FireJournal.tsx";
import { PromptSection } from "./PromptSection.tsx";
import { RotateDialog, SecretDialog } from "./SecretDialog.tsx";
import { SourceSection } from "./SourceSection.tsx";
import { useTriggerEditor } from "./use-trigger-editor.ts";

interface TriggerFormProps {
  readonly view: TriggerView | null;
  readonly draft: Draft;
  onOpenSession(sessionId: string): void;
  onCreated?(id: string): void;
}

/** The editor on the left, the dry-run beside it, the journal under both (board 11 §1, "Éditeur" with the dry-run beside it). */
export function TriggerForm({ view, draft: initial, onOpenSession, onCreated }: TriggerFormProps) {
  const t = useT();
  const phone = useIsPhone();
  const editor = useTriggerEditor({ view, draft: initial, ...(onCreated ? { onCreated } : {}) });
  const [now] = useState(() => Date.now());
  const { draft, set, errors } = editor;
  // A token's view hides the precheck: saving it back would erase the command (RT-04), so the form stays read-only.
  const readOnly = editor.saved?.redacted === true;

  return (
    <div data-trigger-editor="" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-wrap items-start gap-s3 p-s3">
        <div className={cn("flex flex-1 flex-col gap-s3", phone ? "min-w-0" : "min-w-pane")}>
          <EditorHeader
            draft={draft}
            set={set}
            nameError={errors["name"] ?? null}
            canFire={editor.canFire && !readOnly}
            canSave={!readOnly}
            since={editor.since}
            status={editor.status}
            onFire={editor.fire}
            onSave={editor.save}
          />
          {readOnly ? <p className="text-ui text-muted">{t("automation.editor.redacted")}</p> : null}
          <SourceSection
            draft={draft}
            set={set}
            errors={errors}
            now={now}
            webhookUrl={editor.saved?.webhookUrl ?? null}
            canRotate={editor.canRotate && !readOnly}
            onRotate={editor.askRotate}
          />
          <ExecutionSection draft={draft} set={set} errors={errors} />
          <PromptSection draft={draft} set={set} errors={errors} />
        </div>
        <div className={phone ? "min-w-0 flex-1" : "min-w-pane flex-1"}>
          <DryRunPanel
            input={editor.input}
            sourceType={draft.sourceType}
            savedId={editor.saved?.id ?? null}
            onInvalid={editor.attempted}
          />
        </div>
      </div>
      {editor.saved === null ? null : (
        <FireJournal triggerId={editor.saved.id} refreshKey={editor.fires} onOpenSession={onOpenSession} />
      )}
      <SecretDialog secret={editor.secret} onClose={editor.closeSecret} />
      <RotateDialog open={editor.rotating} onCancel={editor.cancelRotate} onConfirm={editor.rotate} />
    </div>
  );
}
