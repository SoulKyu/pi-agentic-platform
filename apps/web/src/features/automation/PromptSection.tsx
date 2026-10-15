import { TextField } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { EditorSection, type SectionProps } from "./EditorSection.tsx";

/** The prompt template; `{{payload}}` is always sent fenced (the hint says so). */
export function PromptSection({ draft, set, errors }: SectionProps) {
  const t = useT();
  return (
    <EditorSection title={t("automation.editor.prompt")}>
      <TextField
        multiline
        mono
        rows={8}
        label={t("automation.editor.prompt")}
        hint={t("automation.editor.prompt.hint")}
        error={errors["prompt"] ?? null}
        value={draft.prompt}
        onChange={(prompt) => set({ prompt })}
      />
    </EditorSection>
  );
}
