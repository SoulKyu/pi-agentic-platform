import { Segmented, TextField } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { EditorSection, type SectionProps } from "./EditorSection.tsx";
import { ScheduleFields } from "./ScheduleFields.tsx";
import { WebhookFields } from "./WebhookFields.tsx";

export interface SourceSectionProps extends SectionProps {
  readonly now: number;
  readonly webhookUrl: string | null;
  readonly canRotate: boolean;
  onRotate(): void;
}

/** Source (board 11 §1): a Segmented Schedule / Webhook / Feed / Manual and the fields of the chosen one. */
export function SourceSection(props: SourceSectionProps) {
  const t = useT();
  const { draft, set, errors } = props;
  return (
    <EditorSection title={t("automation.editor.source")}>
      <Segmented
        label={t("automation.editor.sourceKind")}
        value={draft.sourceType}
        options={[
          { value: "schedule", label: t("automation.trigger.source.schedule") },
          { value: "webhook", label: t("automation.trigger.source.webhook") },
          { value: "feed", label: t("automation.trigger.source.feed") },
          { value: "manual", label: t("automation.trigger.source.manual") },
        ]}
        onChange={(sourceType) => set({ sourceType })}
      />
      {draft.sourceType === "schedule" ? <ScheduleFields {...props} /> : null}
      {draft.sourceType === "webhook" ? <WebhookFields {...props} /> : null}
      {draft.sourceType === "feed" ? (
        <>
          <TextField
            label={t("automation.editor.feed.url")}
            value={draft.feedUrl}
            error={errors["source.url"] ?? null}
            onChange={(feedUrl) => set({ feedUrl })}
          />
          <TextField
            label={t("automation.editor.feed.every")}
            value={draft.feedEvery}
            error={errors["source.everyMinutes"] ?? null}
            onChange={(feedEvery) => set({ feedEvery })}
          />
        </>
      ) : null}
    </EditorSection>
  );
}
