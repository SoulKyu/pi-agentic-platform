import { Segmented, Switch, TextField } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { Draft, FormErrors } from "./agent-form.vm.ts";

interface Props {
  readonly draft: Draft;
  readonly errors: FormErrors;
  set(patch: Partial<Draft>): void;
}

/** The agent's memory, in pi-mem0's terms (capture, save, hint, recall limit and threshold); pi-mem0 must be installed. */
export function MemoryFields({ draft, errors, set }: Props) {
  const t = useT();
  const fail = (key: string) => {
    const error = errors[key];
    return error === undefined ? null : t(error);
  };
  return (
    <fieldset data-slot="agent-memory" className="flex min-w-0 flex-col gap-s2">
      <legend className="label-hud text-muted">{t("agentForm.memory")}</legend>
      <Switch
        label={t("agentForm.memory")}
        checked={draft.memoryOn}
        hint={t("agentForm.memory.note")}
        onChange={(memoryOn) => set({ memoryOn })}
      />
      {draft.memoryOn ? (
        <>
          <Segmented
            label={t("agentForm.memory.capture")}
            value={draft.capture}
            options={[
              { value: "auto", label: t("agentForm.memory.capture.auto") },
              { value: "off", label: t("agentForm.memory.capture.off") },
            ]}
            onChange={(capture) => set({ capture })}
          />
          <Segmented
            label={t("agentForm.memory.save")}
            value={draft.save}
            options={[
              { value: "direct", label: t("agentForm.memory.save.direct") },
              { value: "staged", label: t("agentForm.memory.save.staged") },
            ]}
            onChange={(save) => set({ save })}
          />
          <TextField
            label={t("agentForm.memory.hint")}
            hint={t("agentForm.memory.hint.about")}
            multiline
            rows={2}
            value={draft.memoryHint}
            error={fail("memory.hint")}
            onChange={(memoryHint) => set({ memoryHint })}
          />
          <TextField
            label={t("agentForm.memory.recallLimit")}
            value={draft.recallLimit}
            error={fail("memory.recallLimit")}
            onChange={(recallLimit) => set({ recallLimit })}
          />
          <TextField
            label={t("agentForm.memory.recallThreshold")}
            value={draft.recallThreshold}
            error={fail("memory.recallThreshold")}
            onChange={(recallThreshold) => set({ recallThreshold })}
          />
        </>
      ) : null}
    </fieldset>
  );
}
