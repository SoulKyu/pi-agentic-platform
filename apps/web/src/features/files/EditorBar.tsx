import { Banner, Button, InlineError } from "@pap/ui";
import type { FileMeta } from "@pap/contracts";
import { useT } from "../../i18n/index.ts";
import type { Save } from "./use-save.ts";

interface EditorBarProps {
  readonly save: Save;
  readonly dirty: boolean;
  readonly protection: FileMeta["protection"];
}

function Ask({
  question,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  readonly question: string;
  readonly confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const t = useT();
  return (
    <div role="group" aria-label={question} className="flex flex-col items-start gap-s2">
      <p className="text-ui text-fg">{question}</p>
      <div className="flex gap-s2">
        <Button variant="primary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button onClick={onCancel}>{t("files.edit.cancel")}</Button>
      </div>
    </div>
  );
}

const ALERTS = {
  tooLarge: "files.edit.tooLarge",
  stepUpCancelled: "files.edit.stepUpCancelled",
  gone: "files.edit.gone",
  failed: "files.edit.failed",
} as const;

/** The Save button and what a save asks or says: the protected-file question, the conflict banner, the failures. */
export function EditorBar({ save, dirty, protection }: EditorBarProps) {
  const t = useT();
  const { state } = save;
  let notice;
  if (state.kind === "ask") {
    notice = (
      <Ask
        question={t(protection === "step_up" ? "files.edit.stepUpAsk" : "files.edit.protectedAsk")}
        confirmLabel={t("files.edit.save")}
        onConfirm={save.confirmAsk}
        onCancel={save.cancelAsk}
      />
    );
  } else if (save.reloading) {
    notice = (
      <Ask
        question={t("files.edit.reloadAsk")}
        confirmLabel={t("files.edit.reloadConfirm")}
        onConfirm={save.confirmReload}
        onCancel={save.cancelReload}
      />
    );
  } else if (save.conflicted) {
    notice = (
      <Banner
        tone="capacity"
        title={t("files.edit.conflict")}
        actions={
          <>
            <Button size="sm" onClick={save.askReload}>
              {t("files.edit.reload")}
            </Button>
            <Button size="sm" onClick={save.overwrite} disabled={state.kind === "saving"}>
              {t("files.edit.overwrite")}
            </Button>
          </>
        }
      >
        {t("files.edit.conflictBody")}
      </Banner>
    );
  } else if (state.kind === "unknown") {
    notice = (
      <Banner
        tone="capacity"
        title={t("files.edit.unknown")}
        actions={
          <Button size="sm" onClick={save.askReload}>
            {t("files.edit.reload")}
          </Button>
        }
      />
    );
  } else if (state.kind in ALERTS) {
    notice = <InlineError announce="action">{t(ALERTS[state.kind as keyof typeof ALERTS])}</InlineError>;
  }
  const asking = state.kind === "ask";
  return (
    <div data-slot="editor-bar" className="flex flex-col gap-s2 border-b border-border px-s3 py-s1">
      <div className="flex items-center justify-between gap-s2">
        <span role="status" className="text-ui text-muted">
          {state.kind === "saving"
            ? t("files.edit.saving")
            : dirty
              ? t("files.edit.unsaved")
              : state.kind === "saved"
                ? t("files.edit.saved")
                : ""}
        </span>
        {asking ? null : (
          <Button
            variant="primary"
            size="sm"
            onClick={() => save.save()}
            disabled={!dirty || state.kind === "saving"}
          >
            {t("files.edit.save")}
          </Button>
        )}
      </div>
      {notice}
    </div>
  );
}
