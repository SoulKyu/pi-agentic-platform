import { Avatar, Button, Chip, Markdown, Message, ToolCard } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { useAppearanceStore } from "./appearance-store.ts";

/** A small sample of the real components; the page around it is the live preview. */
export function AppearancePreview() {
  const t = useT();
  const account = useAppearanceStore((state) => state.account);
  return (
    <section
      aria-label={t("settings.appearance.preview")}
      className="flex flex-col gap-s3 rounded-md border border-border bg-bg p-s3"
    >
      <Message author="you" label={t("settings.appearance.sample.youLabel")}>
        {t("settings.appearance.sample.you")}
      </Message>
      <Message author="agent" label={t("settings.appearance.sample.agentLabel")}>
        <Markdown text={t("settings.appearance.sample.agent")} />
      </Message>
      <ToolCard
        name="bash"
        summary={t("settings.appearance.sample.toolSummary")}
        duration={t("settings.appearance.sample.duration")}
        status="done"
        detail={account.toolDetail}
        runningLabel={t("settings.appearance.sample.running")}
        failedLabel={t("settings.appearance.sample.failed")}
      />
      <div className="flex items-center gap-s3">
        <Avatar
          initials="A"
          name={t("settings.appearance.sample.avatarName")}
          avatarStyle={account.avatarStyle}
        />
        <Chip tone="att" label={t("settings.appearance.sample.chip")} />
        <Button variant="primary">{t("settings.appearance.sample.button")}</Button>
      </div>
    </section>
  );
}
