import type { MessageKey } from "../../../i18n/index.ts";
import { useT } from "../../../i18n/index.ts";
import { Button, Heading } from "@pap/ui";
import { PRESETS, type Preset, type PresetKey } from "./presets.ts";

const LABEL: Record<PresetKey, MessageKey> = {
  ollama: "settingsProviders.preset.ollama",
  lmstudio: "settingsProviders.preset.lmstudio",
  vllm: "settingsProviders.preset.vllm",
  openrouter: "settingsProviders.preset.openrouter",
  "openai-compatible": "settingsProviders.preset.openai-compatible",
  "anthropic-compatible": "settingsProviders.preset.anthropic-compatible",
  "gemini-compatible": "settingsProviders.preset.gemini-compatible",
  custom: "settingsProviders.preset.custom",
};

/** The starters (owner q2): a card only prefills the form. */
export function PresetCards({ onPick }: { onPick(preset: Preset): void }) {
  const t = useT();
  return (
    <section aria-label={t("settingsProviders.presets.title")} className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("settingsProviders.presets.title")}
      </Heading>
      <p className="text-ui text-muted">{t("settingsProviders.presets.hint")}</p>
      <div data-slot="preset-cards" className="flex flex-wrap gap-s2">
        {PRESETS.map((preset) => (
          <Button key={preset.key} onClick={() => onPick(preset)}>
            {t(LABEL[preset.key])}
          </Button>
        ))}
      </div>
    </section>
  );
}
