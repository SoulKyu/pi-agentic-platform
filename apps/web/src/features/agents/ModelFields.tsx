import { THINKING_LEVELS, type ThinkingLevel } from "@pap/contracts";
import { Select } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { choiceLabels, levelsFor } from "./model-fields.vm.ts";
import type { AgentModels } from "./use-agent-models.ts";

const DEFAULT = "default";

interface Props {
  readonly models: AgentModels;
  readonly model: { readonly provider: string; readonly modelId: string } | null;
  readonly thinking: ThinkingLevel | null;
  onModel(model: { readonly provider: string; readonly modelId: string } | null): void;
  onThinking(level: ThinkingLevel | null): void;
}

/**
 * The model and thinking fields of the agent form. The levels follow the chosen model, as in a session (M7R45): a model
 * that does not reason keeps thinking off. Models that share a name show their provider; a cut-short list says so.
 */
export function ModelFields({ models, model, thinking, onModel, onThinking }: Props) {
  const t = useT();
  const labels = choiceLabels(models.choices, (name, provider) =>
    t("agentForm.model.provider", { name, provider }),
  );
  const modelAt =
    model === null
      ? -1
      : models.choices.findIndex((c) => c.provider === model.provider && c.id === model.modelId);
  const chosen = modelAt === -1 ? undefined : models.choices[modelAt];
  const modelOptions = [
    { value: DEFAULT, label: t("agentForm.model.default") },
    ...(model !== null && modelAt === -1
      ? [{ value: "saved", label: `${model.provider}/${model.modelId}` }]
      : []),
    ...models.choices.map((_, index) => ({ value: `m${index}`, label: labels[index] ?? "" })),
  ];
  const modelValue = model === null ? DEFAULT : modelAt === -1 ? "saved" : `m${modelAt}`;
  const allowed = levelsFor(chosen);
  // A level saved before the model changed stays visible, so the form never hides what it will send.
  const shown = THINKING_LEVELS.filter((level) => allowed.includes(level) || level === thinking);
  const offOnly = allowed.length === 1;
  const modelHint = models.failed
    ? t("agentForm.model.failed")
    : models.truncated
      ? t("agentForm.model.truncated")
      : undefined;
  return (
    <>
      <div data-slot="agent-model">
        <Select
          label={t("agentForm.model")}
          value={modelValue}
          options={modelOptions}
          onChange={(value) => {
            const choice = value.startsWith("m") ? models.choices[Number(value.slice(1))] : undefined;
            if (value === DEFAULT) onModel(null);
            else if (choice !== undefined) {
              onModel({ provider: choice.provider, modelId: choice.id });
              // A model without reasoning cannot keep a level above off.
              if (thinking !== null && !levelsFor(choice).includes(thinking)) onThinking(null);
            }
          }}
          {...(modelHint === undefined ? {} : { hint: modelHint })}
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
