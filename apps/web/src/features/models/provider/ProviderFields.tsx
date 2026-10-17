import { HTTP_PLAINTEXT_POLICY, keyTravelsInClear, PROVIDER_API_TYPES } from "@pap/contracts";
import { Segmented, Select, TextField } from "@pap/ui";
import { type MessageKey, useT } from "../../../i18n/index.ts";
import { columns } from "./layout.ts";
import {
  type AuthDraft,
  carriesSecret,
  type Draft,
  type Problem,
  problemAt,
  slug,
} from "./provider-form.vm.ts";

const API_LABEL: Record<(typeof PROVIDER_API_TYPES)[number], MessageKey> = {
  "openai-completions": "settingsProviders.api.openai-completions",
  "openai-responses": "settingsProviders.api.openai-responses",
  "anthropic-messages": "settingsProviders.api.anthropic-messages",
  "google-generative-ai": "settingsProviders.api.google-generative-ai",
  "mistral-conversations": "settingsProviders.api.mistral-conversations",
};
// A required field says nothing while it is empty: Save stays off and the label tells what is expected.
const QUIET = new Set(["id.required", "baseUrl.required", "headers.value", "models.idRequired"]);

export interface FieldsProps {
  readonly draft: Draft;
  readonly problems: readonly Problem[];
  /** `at` values the helper refused when saving. */
  readonly refused: ReadonlySet<string>;
  readonly editing: boolean;
  /** `auth.json` holds a key for this identifier: Pi uses it before any `apiKey` of `models.json`. */
  readonly keyHeld: boolean;
  readonly stack: boolean;
  onChange(next: Draft): void;
}

export function useProblemText(problems: readonly Problem[], refused: ReadonlySet<string>) {
  const t = useT();
  return (at: string): string | null => {
    const key = problemAt(problems, at);
    if (key !== undefined && !QUIET.has(key)) return t(`settingsProviders.problem.${key}`);
    return refused.has(at) ? t("settingsProviders.issue.field") : null;
  };
}

/** Connection: name, identifier, API type, base URL with the policy as text, and the clear-text warning. */
export function ConnectionFields(props: FieldsProps) {
  const t = useT();
  const { draft, onChange } = props;
  const errorAt = useProblemText(props.problems, props.refused);
  const derivedId = !props.editing && draft.id === slug(draft.name);
  const policy =
    HTTP_PLAINTEXT_POLICY === "loopback"
      ? t("settingsProviders.url.policy.loopback")
      : t("settingsProviders.url.policy.any");
  const warn =
    HTTP_PLAINTEXT_POLICY === "any" && keyTravelsInClear(draft.baseUrl.trim(), carriesSecret(draft));
  return (
    <section aria-label={t("settingsProviders.section.connection")} className="flex flex-col gap-s3">
      <h3 className="label-hud text-muted">{t("settingsProviders.section.connection")}</h3>
      <div className={columns(props.stack)}>
        <TextField
          label={t("settingsProviders.field.name")}
          value={draft.name}
          error={errorAt("name")}
          onChange={(name) => onChange({ ...draft, name, ...(derivedId ? { id: slug(name) } : {}) })}
        />
        <TextField
          label={t("settingsProviders.field.id")}
          hint={props.editing ? undefined : t("settingsProviders.field.id.hint")}
          value={draft.id}
          disabled={props.editing}
          error={errorAt("id")}
          onChange={(id) => onChange({ ...draft, id })}
        />
        <Select
          label={t("settingsProviders.field.api")}
          value={draft.api}
          options={PROVIDER_API_TYPES.map((value) => ({ value, label: t(API_LABEL[value]) }))}
          onChange={(api) => onChange({ ...draft, api })}
        />
      </div>
      <TextField
        label={t("settingsProviders.field.url")}
        hint={policy}
        value={draft.baseUrl}
        error={errorAt("baseUrl")}
        onChange={(baseUrl) => onChange({ ...draft, baseUrl })}
      />
      {warn ? (
        <p role="status" className="text-ui text-attn">
          {t("settingsProviders.url.clearText")}
        </p>
      ) : null}
    </section>
  );
}

/** Authentication: where the key comes from. There is no key field here (MPR12): a stored key is typed in `ApiKeyForm` after the save. */
export function AuthFields(props: FieldsProps) {
  const t = useT();
  const { draft, onChange } = props;
  const errorAt = useProblemText(props.problems, props.refused);
  const kind = draft.auth.kind;
  const options = [
    { value: "stored", label: t("settingsProviders.auth.stored") },
    { value: "env", label: t("settingsProviders.auth.env") },
    { value: "none", label: t("settingsProviders.auth.none") },
    ...(kind === "keep" ? [{ value: "keep", label: t("settingsProviders.auth.keep") }] : []),
  ] as const;
  const choose = (next: AuthDraft["kind"]) => {
    if (next === kind) return;
    onChange({ ...draft, auth: next === "env" ? { kind: "env", name: "" } : { kind: next } });
  };
  return (
    <section aria-label={t("settingsProviders.section.auth")} className="flex flex-col gap-s2">
      <h3 className="label-hud text-muted">{t("settingsProviders.section.auth")}</h3>
      <Segmented label={t("settingsProviders.auth.label")} value={kind} options={options} onChange={choose} />
      {draft.auth.kind === "stored" ? (
        <p className="text-ui text-muted">{t("settingsProviders.auth.stored.note")}</p>
      ) : null}
      {draft.auth.kind === "none" ? (
        <p className="text-ui text-muted">{t("settingsProviders.auth.none.note")}</p>
      ) : null}
      {props.keyHeld && (props.editing ? kind === "env" || kind === "none" : true) ? (
        <p role="status" className="text-ui text-attn">
          {t(
            props.editing
              ? "settingsProviders.auth.keyHeld.override"
              : "settingsProviders.auth.keyHeld.reused",
          )}
        </p>
      ) : null}
      {draft.auth.kind === "keep" ? (
        <p className="text-ui text-muted">{t("settingsProviders.auth.keep.note")}</p>
      ) : null}
      {draft.auth.kind === "env" ? (
        <TextField
          label={t("settingsProviders.auth.envName")}
          hint={t("settingsProviders.auth.env.hint")}
          value={draft.auth.name}
          error={draft.auth.name.trim() === "" ? null : errorAt("auth")}
          onChange={(name) => onChange({ ...draft, auth: { kind: "env", name } })}
        />
      ) : null}
    </section>
  );
}
