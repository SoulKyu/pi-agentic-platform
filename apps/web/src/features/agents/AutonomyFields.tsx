import { Switch, TextField } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { Draft, FormErrors } from "./agent-form.vm.ts";

interface Props {
  readonly draft: Draft;
  readonly errors: FormErrors;
  /** The name as typed, or empty while the field is. */
  readonly name: string;
  set(patch: Partial<Draft>): void;
}

/**
 * What the agent may do on its own after reading outside content (owner a1, a6): the hosts the person controls, which
 * do not count as external, and the switch that lifts the extra questions for the shell's network, `agent_remind` and
 * `agent_delegate`. The switch is off by default; turning it on, or adding a source, asks for the password on save.
 */
export function AutonomyFields({ draft, errors, name, set }: Props) {
  const t = useT();
  const who = name === "" ? t("agentForm.autonomy.thisAgent") : name;
  const error = errors.trustedSources;
  return (
    <fieldset data-slot="agent-autonomy" className="flex min-w-0 flex-col gap-s2">
      <legend className="label-hud text-muted">{t("agentForm.autonomy")}</legend>
      <TextField
        label={t("agentForm.sources")}
        hint={t("agentForm.sources.hint")}
        multiline
        mono
        rows={3}
        value={draft.trustedSources}
        error={error === undefined ? null : t(error)}
        onChange={(trustedSources) => set({ trustedSources })}
      />
      <Switch
        label={t("agentForm.autonomy.switch")}
        hint={t("agentForm.autonomy.hint", { name: who })}
        checked={draft.trustedAutonomy}
        onChange={(trustedAutonomy) => set({ trustedAutonomy })}
      />
      {draft.ownHosts ? (
        <p className="text-ui text-muted">{t("agentForm.autonomy.noList", { name: who })}</p>
      ) : null}
    </fieldset>
  );
}
