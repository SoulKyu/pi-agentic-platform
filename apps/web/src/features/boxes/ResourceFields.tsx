import "../../i18n/register-boxes.ts";
import { AgentResources as Bounds, VM_OVERHEAD_MB } from "@pap/contracts";
import { Switch, TextField } from "@pap/ui";
import { type MessageKey, useLocale, useT } from "../../i18n/index.ts";
import { formatGb } from "../../lib/format-gb.ts";

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
  readonly alwaysOn: boolean;
  /** About the three fields only (shown before the switch, which applies at once). */
  readonly note?: string;
  setAlwaysOn(on: boolean): void;
  set(patch: Partial<ResourceDraft>): void;
}

// The host's own ceilings (its memory, its cores) are checked by the daemon at save (RT-30, a plain `bad_request`).
const FIELDS = [
  { key: "memoryMb", label: "agentVm.memory", bounds: Bounds.shape.memoryMb },
  { key: "cpus", label: "agentVm.cpus", bounds: Bounds.shape.cpus },
  { key: "diskMb", label: "agentVm.disk", bounds: Bounds.shape.diskMb },
] as const;

/**
 * Memory, CPUs and disk of a microVM: an agent's and a box project's, then the Always on switch. The disk can only be
 * enlarged, so a value below the saved one is refused by the caller and never sent.
 */
export function ResourceFields({ draft, errors, legend, alwaysOn, setAlwaysOn, set, note }: Props) {
  const t = useT();
  const locale = useLocale();
  // What the switch reserves: the typed memory plus the VM's own overhead; a draft that is not a valid memory size keeps the first sentence only.
  const typed = draft.memoryMb.trim() === "" ? Number.NaN : Number(draft.memoryMb);
  const hint = Bounds.shape.memoryMb.safeParse(typed).success
    ? t("agentVm.alwaysOn.hint", {
        memory: t("agentVm.size", { value: formatGb(typed + VM_OVERHEAD_MB, locale) }),
      })
    : t("agentVm.alwaysOn.hintShort");
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
      {note === undefined ? null : <p className="text-ui text-muted">{note}</p>}
      <Switch label={t("agentVm.alwaysOn.label")} hint={hint} checked={alwaysOn} onChange={setAlwaysOn} />
    </fieldset>
  );
}
