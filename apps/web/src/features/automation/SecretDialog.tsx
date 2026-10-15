import { Button } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A webhook secret, shown once (Task 3): after a create, an update that made the trigger a webhook, or a rotation. The value lives
 * only in the parent's state while this is open; closing drops it. It is never put in a URL, a log or the form.
 */
export function SecretDialog({ secret, onClose }: { readonly secret: string | null; onClose(): void }) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (secret !== null) input.current?.select();
  }, [secret]);
  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopy("idle");
          onClose();
        }
      }}
      title={t("automation.editor.secret.title")}
      description={t("automation.editor.secret.body")}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              if (secret !== null) void copyText(secret).then((done) => setCopy(done ? "copied" : "failed"));
            }}
          >
            {t("automation.editor.webhook.copy")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("automation.editor.secret.done")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        <label htmlFor={id} className="label-hud text-muted">
          {t("automation.editor.secret.value")}
        </label>
        <input
          id={id}
          ref={input}
          readOnly
          autoComplete="off"
          spellCheck={false}
          value={secret ?? ""}
          className="h-control w-full rounded-sm border border-control-border bg-bg px-s2 font-mono text-code text-fg focus-ring"
        />
        {copy === "idle" ? null : (
          <p role="status" className="text-ui text-muted">
            {t(
              copy === "copied" ? "automation.editor.webhook.copied" : "automation.editor.webhook.copyFailed",
            )}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** "Rotate the secret?": the old one stops working at once, so the person confirms first. */
export function RotateDialog({
  open,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={t("automation.editor.webhook.rotateTitle")}
      description={t("automation.editor.webhook.rotateBody")}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t("automation.editor.webhook.rotateCancel")}
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            {t("automation.editor.webhook.rotateConfirm")}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}
