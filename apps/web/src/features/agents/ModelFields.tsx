import { THINKING_LEVELS, type ThinkingLevel, type ToolPreset } from "@pap/contracts";
import { Select } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { ModelPickerField, type PickerModel } from "../models/picker/index.ts";
import { levelsFor } from "./model-fields.vm.ts";

const DEFAULT = "default";

type ModelRef = { readonly provider: string; readonly modelId: string };

interface Props {
  readonly model: ModelRef | null;
  /** The form's tool preset: Chat only loads no extension, so no model an extension adds is offered to the agent. */
  readonly preset: ToolPreset;
  readonly thinking: ThinkingLevel | null;
  /** The levels the picked model allows; the form follows the picker's summary of it (M7R45). */
  readonly levels: readonly ThinkingLevel[];
  onModel(model: ModelRef | null, summary?: PickerModel): void;
  onThinking(level: ThinkingLevel | null): void;
}

/**
 * The model and thinking fields of the agent form. The model is the shared picker (MPR4: the models Pi would let a
 * session use, no project folder for an agent); the levels follow the chosen model, as in a session (M7R45): a model
 * that does not reason keeps thinking off.
 */
export function ModelFields({ model, preset, thinking, levels, onModel, onThinking }: Props) {
  const t = useT();
  // A level saved before the model changed stays visible, so the form never hides what it will send.
  const shown = THINKING_LEVELS.filter((level) => levels.includes(level) || level === thinking);
  const offOnly = levels.length === 1;
  return (
    <>
      <div data-slot="agent-model">
        <ModelPickerField
          label={t("agentForm.model")}
          value={model}
          cwd={null}
          defaultLabel={t("agentForm.model.default")}
          extensionsLoaded={preset !== "chat"}
          onChange={(next, summary) => {
            onModel(next, summary);
            // A model without reasoning cannot keep a level above off.
            if (thinking !== null && !levelsFor(summary).includes(thinking)) onThinking(null);
          }}
        />
      </div>
      <Select
        label={t("agentForm.thinking")}
        value={thinking ?? DEFAULT}
        options={[
          { value: DEFAULT, label: t("agentForm.thinking.default") },
          ...shown.map((level) => ({ value: level, label: t(`agentForm.thinking.${level}`) })),
        ]}
        onChange={(value) => onThinking(value === DEFAULT ? null : (value as ThinkingLevel))}
        {...(offOnly ? { hint: t("agentForm.thinking.offOnly") } : {})}
      />
    </>
  );
}
