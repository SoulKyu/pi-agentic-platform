import { HMAC_HEADERS } from "@pap/contracts";
import { Button, Segmented, Select, Switch, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import type { SectionProps } from "./EditorSection.tsx";

export interface WebhookFieldsProps extends SectionProps {
  /** Null until the trigger is saved. */
  readonly webhookUrl: string | null;
  readonly canRotate: boolean;
  onRotate(): void;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** The hook's address with Copy, how it authenticates, how its body is read, its limits, and Rotation. The secret itself is never here. */
export function WebhookFields({ draft, set, errors, webhookUrl, canRotate, onRotate }: WebhookFieldsProps) {
  const t = useT();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const copyUrl = (url: string) => void copyText(url).then((done) => setCopy(done ? "copied" : "failed"));

  return (
    <>
      <div className="flex flex-col gap-s1">
        <span className="label-hud text-muted">{t("automation.editor.webhook.url")}</span>
        {webhookUrl === null ? (
          <p className="text-ui text-muted">{t("automation.editor.webhook.urlAfterSave")}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-s2">
            <code className="min-w-0 flex-1 break-all font-mono text-code text-fg">{webhookUrl}</code>
            <Button size="sm" onClick={() => copyUrl(webhookUrl)}>
              {t("automation.editor.webhook.copy")}
            </Button>
          </div>
        )}
        {copy === "idle" ? null : (
          <p role="status" className="text-ui text-muted">
            {t(
              copy === "copied" ? "automation.editor.webhook.copied" : "automation.editor.webhook.copyFailed",
            )}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-s3">
        <Segmented
          label={t("automation.editor.webhook.auth")}
          value={draft.auth}
          options={[
            { value: "secret", label: t("automation.editor.webhook.authSecret") },
            { value: "hmac", label: t("automation.editor.webhook.authHmac") },
          ]}
          onChange={(auth) => set({ auth })}
        />
        <Button disabled={!canRotate} onClick={onRotate}>
          {t("automation.editor.webhook.rotate")}
        </Button>
      </div>
      {draft.auth === "hmac" ? (
        <Select
          label={t("automation.editor.webhook.hmacHeader")}
          value={draft.hmacHeader}
          options={HMAC_HEADERS.map((header) => ({ value: header, label: header }))}
          onChange={(hmacHeader) => set({ hmacHeader })}
        />
      ) : null}
      <Segmented
        label={t("automation.editor.webhook.format")}
        value={draft.format}
        options={[
          { value: "raw", label: t("automation.editor.webhook.formatRaw") },
          { value: "alertmanager", label: t("automation.editor.webhook.formatAlertmanager") },
          { value: "grafana", label: t("automation.editor.webhook.formatGrafana") },
        ]}
        onChange={(format) => set({ format })}
      />
      <TextField
        label={t("automation.editor.webhook.dedup")}
        value={draft.dedupMinutes}
        error={errors["source.dedupMinutes"] ?? null}
        onChange={(dedupMinutes) => set({ dedupMinutes })}
      />
      <p className="font-mono text-code text-muted">
        {t("automation.editor.webhook.limits", { minutes: draft.dedupMinutes })}
      </p>
      {draft.format === "raw" ? null : (
        <Switch
          label={t("automation.editor.webhook.onResolved")}
          checked={draft.onResolved === "run"}
          onChange={(on) => set({ onResolved: on ? "run" : "skip" })}
        />
      )}
    </>
  );
}
