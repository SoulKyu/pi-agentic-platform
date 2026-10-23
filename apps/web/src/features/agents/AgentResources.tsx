import "./register-agent-catalog.ts";
import { AgentResources as Bounds } from "@pap/contracts";
import { TextField } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { Draft, FormErrors } from "./agent-form.vm.ts";

interface Props {
  readonly draft: Draft;
  readonly errors: FormErrors;
  set(patch: Partial<Draft>): void;
}

// The host's own ceilings (its memory, its cores) are checked by the daemon at save (RT-30, a plain `bad_request`).
// `agents.vmStatus` carries them as `host` (AVM-E33) but this form does not read them: it shows the contract's bounds.
const FIELDS = [
  { key: "memoryMb", label: "agentVm.memory", bounds: Bounds.shape.memoryMb },
  { key: "cpus", label: "agentVm.cpus", bounds: Bounds.shape.cpus },
  { key: "diskMb", label: "agentVm.disk", bounds: Bounds.shape.diskMb },
] as const;

/**
 * An agent in a VM: memory, CPUs and disk, then what the VM does not do yet (the vault, prechecks). The disk can only be
 * enlarged, so a value below the saved one is refused here and never sent.
 */
export function AgentResources({ draft, errors, set }: Props) {
  const t = useT();
  return (
    <fieldset data-slot="agent-vm" className="flex min-w-0 flex-col gap-s2">
      <legend className="label-hud text-muted">{t("agentVm.title")}</legend>
      {FIELDS.map(({ key, label, bounds }) => {
        const error = errors[`resources.${key}`];
        return (
          <TextField
            key={key}
            label={t(label)}
            hint={[
              t("agentVm.range", { min: bounds.minValue ?? 0, max: bounds.maxValue ?? 0 }),
              ...(key === "diskMb" ? [t("agentVm.disk.hint")] : []),
            ].join(" ")}
            value={draft[key]}
            error={error === undefined ? null : t(error)}
            autoComplete="off"
            onChange={(value) => set({ [key]: value })}
          />
        );
      })}
    </fieldset>
  );
}
