import { PROVIDER_FORM_LIMITS } from "@pap/contracts";
import { Button, Checkbox, Heading, InlineError, TextField } from "@pap/ui";
import { useT } from "../../../i18n/index.ts";
import { columns } from "./layout.ts";
import { type FieldsProps, useProblemText } from "./ProviderFields.tsx";
import { emptyModel, type ModelDraft } from "./provider-form.vm.ts";

function Row({
  model,
  at,
  stack,
  errorAt,
  onChange,
  onRemove,
}: {
  readonly model: ModelDraft;
  readonly at: string;
  readonly stack: boolean;
  errorAt(at: string): string | null;
  onChange(next: ModelDraft): void;
  onRemove(): void;
}) {
  const t = useT();
  const rowError = errorAt(at);
  return (
    <li data-model-row={at} className="flex flex-col gap-s2 rounded-md border border-border p-s3">
      <div className={columns(stack)}>
        <TextField
          label={t("settingsProviders.models.id")}
          value={model.id}
          error={errorAt(`${at}.id`)}
          onChange={(id) => onChange({ ...model, id })}
        />
        <TextField
          label={t("settingsProviders.models.name")}
          value={model.name}
          onChange={(name) => onChange({ ...model, name })}
        />
        <TextField
          label={t("settingsProviders.models.contextWindow")}
          value={model.contextWindow}
          error={errorAt(`${at}.contextWindow`)}
          onChange={(contextWindow) => onChange({ ...model, contextWindow })}
        />
        <TextField
          label={t("settingsProviders.models.maxTokens")}
          value={model.maxTokens}
          error={errorAt(`${at}.maxTokens`)}
          onChange={(maxTokens) => onChange({ ...model, maxTokens })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-s3">
        <Checkbox
          label={t("settingsProviders.models.reasoning")}
          checked={model.reasoning}
          onChange={(reasoning) => onChange({ ...model, reasoning })}
        />
        <Checkbox
          label={t("settingsProviders.models.image")}
          checked={model.image}
          onChange={(image) => onChange({ ...model, image })}
        />
      </div>
      {rowError ? <InlineError announce="action">{rowError}</InlineError> : null}
      <div>
        <Button onClick={onRemove}>{t("settingsProviders.models.remove")}</Button>
      </div>
    </li>
  );
}

/** Models, added by hand (discovery arrives with task 12): at most 500 rows, each with the fields the form owns. */
export function ModelRows(props: FieldsProps) {
  const t = useT();
  const { draft, onChange } = props;
  const errorAt = useProblemText(props.problems, props.refused);
  const set = (models: readonly ModelDraft[]) => onChange({ ...draft, models });
  const limit = errorAt("models");
  return (
    <section aria-label={t("settingsProviders.section.models")} className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("settingsProviders.section.models")}
      </Heading>
      {draft.models.length === 0 ? (
        <p className="text-ui text-muted">{t("settingsProviders.models.none")}</p>
      ) : (
        <ul className="flex flex-col gap-s2">
          {draft.models.map((model, index) => (
            <Row
              // Rows have no identity of their own; they are only added at the end and removed by index.
              key={index}
              model={model}
              at={`models.${index}`}
              stack={props.stack}
              errorAt={errorAt}
              onChange={(next) => set(draft.models.map((one, i) => (i === index ? next : one)))}
              onRemove={() => set(draft.models.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      )}
      {limit ? <InlineError announce="action">{limit}</InlineError> : null}
      {draft.models.length < PROVIDER_FORM_LIMITS.models ? (
        <div>
          <Button onClick={() => set([...draft.models, emptyModel()])}>
            {t("settingsProviders.models.add")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
