import { credentialName, PROVIDER_FORM_LIMITS } from "@pap/contracts";
import { Button, Switch, TextField } from "@pap/ui";
import { useT } from "../../../i18n/index.ts";
import { columns } from "./layout.ts";
import { useProblemText } from "./ProviderFields.tsx";
import { type FieldsProps } from "./ProviderFields.tsx";
import { emptyHeader, type HeaderDraft } from "./provider-form.vm.ts";

/** A name that holds a credential word takes an environment variable only (owner q8): a literal there would sit in the file. */
function Row({
  header,
  at,
  stack,
  error,
  onChange,
  onRemove,
}: {
  readonly header: HeaderDraft;
  readonly at: string;
  readonly stack: boolean;
  readonly error: string | null;
  onChange(next: HeaderDraft): void;
  onRemove(): void;
}) {
  const t = useT();
  const locked = credentialName(header.name);
  const value = header.value;
  const rename = (name: string) =>
    onChange({
      name,
      value: credentialName(name) && value.kind === "literal" ? { kind: "env", name: "" } : value,
    });
  return (
    <li data-header-row={at} className="flex flex-col gap-s2 rounded-md border border-border p-s3">
      <div className={columns(stack)}>
        <TextField
          label={t("settingsProviders.headers.name")}
          value={header.name}
          // A kept value is matched to the file by its name: replace the value before renaming (MPR-C4).
          disabled={value.kind === "keep"}
          onChange={rename}
        />
        {value.kind === "keep" ? (
          <div className="flex flex-col items-start gap-s1">
            <p className="text-ui text-muted">{t("settingsProviders.headers.kept")}</p>
            <Button
              onClick={() =>
                onChange({
                  ...header,
                  value: locked ? { kind: "env", name: "" } : { kind: "literal", text: "" },
                })
              }
            >
              {t("settingsProviders.headers.replace")}
            </Button>
          </div>
        ) : value.kind === "env" ? (
          <TextField
            label={t("settingsProviders.headers.envName")}
            value={value.name}
            onChange={(name) => onChange({ ...header, value: { kind: "env", name } })}
          />
        ) : (
          <TextField
            label={t("settingsProviders.headers.value")}
            value={value.text}
            onChange={(text) => onChange({ ...header, value: { kind: "literal", text } })}
          />
        )}
      </div>
      {value.kind !== "keep" ? (
        <Switch
          label={t("settingsProviders.headers.useEnv")}
          checked={value.kind === "env"}
          disabled={locked}
          onChange={(on) =>
            onChange({ ...header, value: on ? { kind: "env", name: "" } : { kind: "literal", text: "" } })
          }
        />
      ) : null}
      {locked ? (
        <p className="text-ui text-muted">{t("settingsProviders.headers.credentialReason")}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui text-attn">
          {error}
        </p>
      ) : null}
      <div>
        <Button onClick={onRemove}>{t("settingsProviders.headers.remove")}</Button>
      </div>
    </li>
  );
}

/** Headers: at most eight rows, each a literal, an environment variable, or a kept value (a secret-looking literal the file holds). */
export function HeaderRows(props: FieldsProps) {
  const t = useT();
  const { draft, onChange } = props;
  const errorAt = useProblemText(props.problems, props.refused);
  const set = (headers: readonly HeaderDraft[]) => onChange({ ...draft, headers });
  return (
    <section aria-label={t("settingsProviders.section.headers")} className="flex flex-col gap-s2">
      <h3 className="label-hud text-muted">{t("settingsProviders.section.headers")}</h3>
      {draft.headers.length === 0 ? (
        <p className="text-ui text-muted">{t("settingsProviders.headers.none")}</p>
      ) : (
        <ul className="flex flex-col gap-s2">
          {draft.headers.map((header, index) => (
            <Row
              // Rows have no identity of their own; they are only added at the end and removed by index.
              key={index}
              header={header}
              at={`headers.${index}`}
              stack={props.stack}
              error={errorAt(`headers.${index}`)}
              onChange={(next) => set(draft.headers.map((one, i) => (i === index ? next : one)))}
              onRemove={() => set(draft.headers.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      )}
      {draft.headers.length < PROVIDER_FORM_LIMITS.headers ? (
        <div>
          <Button onClick={() => set([...draft.headers, emptyHeader()])}>
            {t("settingsProviders.headers.add")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
