import "../../i18n/register-github.ts";
import { Button, Chip, InlineError, LoadingLine, TextField } from "@pap/ui";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { useRepositories } from "./use-repositories.ts";

const SHOWN = 8;

interface Props {
  readonly value: string;
  readonly error: MessageKey | null;
  onChange(value: string): void;
}

/**
 * A repository as `owner/name`: typed, or picked from the owner's own (`github.repositories`, searched by what is typed).
 * Names are shown as plain text.
 */
export function RepositoryPicker({ value, error, onChange }: Props) {
  const t = useT();
  const found = useRepositories(value);
  return (
    <div className="flex flex-col gap-s2">
      <TextField
        label={t("github.repo.label")}
        hint={t("github.repo.hint")}
        value={value}
        name="repository"
        autoComplete="off"
        error={error === null ? null : t(error)}
        onChange={onChange}
      />
      {found.kind === "loading" ? <LoadingLine label={t("github.repo.loading")} /> : null}
      {found.kind === "failed" ? <InlineError announce="background">{t(found.key)}</InlineError> : null}
      {found.kind === "ready" && found.repositories.length === 0 ? (
        <p className="text-ui text-muted">{t("github.repo.none")}</p>
      ) : null}
      {found.kind === "ready" && found.repositories.length > 0 ? (
        <ul aria-label={t("github.repo.list")} className="flex flex-col gap-s1">
          {found.repositories.slice(0, SHOWN).map((repository) => (
            <li key={repository.fullName} className="flex items-center gap-s2">
              <Button variant="ghost" size="sm" onClick={() => onChange(repository.fullName)}>
                <span className="font-mono text-code normal-case">{repository.fullName}</span>
              </Button>
              {repository.private ? <Chip tone="mut" label={t("github.repo.private")} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
