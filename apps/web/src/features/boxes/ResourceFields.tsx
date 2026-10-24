import "../../i18n/register-boxes.ts";
import { AgentResources as Bounds } from "@pap/contracts";
import { TextField } from "@pap/ui";
import { type MessageKey, useT } from "../../i18n/index.ts";

/** The three fields as typed text; whole numbers, judged by the contract (memory and disk in MiB). */
export interface ResourceDraft {
  readonly memoryMb: string;
  readonly cpus: string;
  readonly diskMb: string;
}

interface Props {
  readonly draft: ResourceDraft;
  readonly errors: Readonly<Partial<Record<string, MessageKey>>>;
  readonly legend: string;
  set(patch: Partial<ResourceDraft>): void;
}

// The host's own ceilings (its memory, its cores) are checked by the daemon at save (RT-30, a plain `bad_request`).
const FIELDS = [
  { key: "memoryMb", label: "agentVm.memory", bounds: Bounds.shape.memoryMb },
  { key: "cpus", label: "agentVm.cpus", bounds: Bounds.shape.cpus },
  { key: "diskMb", label: "agentVm.disk", bounds: Bounds.shape.diskMb },
] as const;

/**
 * Memory, CPUs and disk of a microVM: an agent's and a box project's. The disk can only be enlarged, so a value below
 * the saved one is refused by the caller and never sent.
 */
export function ResourceFields({ draft, errors, legend, set }: Props) {
  const t = useT();
  return (
    <fieldset data-slot="agent-vm" className="flex min-w-0 flex-col gap-s2">
      <legend className="label-hud text-muted">{legend}</legend>
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
            numeric
            onChange={(value) => set({ [key]: value })}
          />
        );
      })}
    </fieldset>
  );
}
