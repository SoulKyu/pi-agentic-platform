import { Banner, Segmented } from "@pap/ui";
import { useState } from "react";
import { switchLocale, useLocale, useT, type Locale } from "../../i18n/index.ts";

/** Per device: `pap.locale` in localStorage only. When the browser refuses it, the choice holds for this page. */
export function LanguageSection() {
  const t = useT();
  const locale = useLocale();
  const [stored, setStored] = useState(true);
  return (
    <div className="flex flex-col gap-s3">
      <Segmented<Locale>
        label={t("settings.language.label")}
        value={locale}
        options={[
          { value: "en", label: t("settings.language.en") },
          { value: "fr", label: t("settings.language.fr") },
        ]}
        onChange={(next) => setStored(switchLocale(next))}
      />
      {stored ? null : <Banner tone="capacity" title={t("settings.language.notStored")} />}
    </div>
  );
}
