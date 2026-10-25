import type { SkillsSearchResult } from "@pap/contracts";
import { Button, Heading, InlineError, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { ScopePicker, useInstallScope } from "./ScopePicker.tsx";
import {
  escapeHidden,
  installCommand,
  safeLink,
  skillsFailureText,
  type InstallScope,
  type ProjectRef,
} from "./skills.vm.ts";

/** One result of skills.sh: untrusted text, rendered as text; its link opens in a new tab and only when it is `https:`. */
function Result({ row, onUse }: { readonly row: SkillsSearchResult["results"][number]; onUse(): void }) {
  const t = useT();
  const link = safeLink(row.url);
  return (
    <li className="flex items-center gap-s2">
      <div className="min-w-0 flex-1">
        <p className="break-all text-ui text-fg">{escapeHidden(row.name)}</p>
        <p className="break-all text-ui text-muted">
          {escapeHidden(row.source)}
          {row.installs === null ? "" : ` · ${t("settingsSkills.search.installs", { count: row.installs })}`}
        </p>
      </div>
      {link === null ? null : (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("settingsSkills.search.openLabel", { name: escapeHidden(row.name) })}
          className="text-ui text-agent focus-ring"
        >
          {t("settingsSkills.search.open")}
        </a>
      )}
      <Button
        aria-label={t("settingsSkills.search.useLabel", { source: escapeHidden(row.source) })}
        onClick={onUse}
      >
        {t("settingsSkills.search.use")}
      </Button>
    </li>
  );
}

/**
 * Search on skills.sh, and the install card (M7R118, M7R140): the scope comes first and the card names the exact command
 * pap runs for it. A search is the one call that sends the owner's words to skills.sh, and only when they press Search.
 */
export function SkillSearch({
  project,
  needsTrust,
  busy,
  onInstall,
}: {
  readonly project: ProjectRef | null;
  readonly needsTrust: boolean;
  readonly busy: boolean;
  onInstall(source: string, scope: InstallScope): void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillsSearchResult["results"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [source, setSource] = useState("");
  const [scope, setScope] = useInstallScope(project, needsTrust);

  const search = () => {
    setSearching(true);
    setProblem(null);
    getRuntime()
      .rpc.call("skills.search", { query: query.trim() })
      .then(
        (answer) => setResults(answer.results),
        (failure: unknown) => setProblem(skillsFailureText(failure, "search")),
      )
      .finally(() => setSearching(false));
  };

  return (
    <div className="flex flex-col gap-s4">
      <section data-skill-search className="flex flex-col items-start gap-s2">
        <TextField
          label={t("settingsSkills.search.label")}
          hint={t("settingsSkills.search.note")}
          value={query}
          autoComplete="off"
          onChange={setQuery}
          onSubmitShortcut={() => query.trim() !== "" && !searching && search()}
        />
        <Button disabled={query.trim() === "" || searching} onClick={search}>
          {t("settingsSkills.search.submit")}
        </Button>
        {problem === null ? null : <InlineError announce="action">{problem}</InlineError>}
        {results === null ? null : results.length === 0 ? (
          <p className="text-ui text-muted">{t("settingsSkills.search.none")}</p>
        ) : (
          <ul data-skill-results className="flex w-full flex-col gap-s1">
            {results.map((row) => (
              <Result key={`${row.source}/${row.name}`} row={row} onUse={() => setSource(row.source)} />
            ))}
          </ul>
        )}
      </section>
      <section data-skill-install className="flex flex-col items-start gap-s2">
        <Heading level={4} variant="group">
          {t("settingsSkills.install.title")}
        </Heading>
        <ScopePicker scope={scope} project={project} needsTrust={needsTrust} onChange={setScope} />
        <TextField
          label={t("settingsSkills.install.source")}
          value={source}
          autoComplete="off"
          onChange={setSource}
        />
        <p className="break-all font-mono text-ui text-muted">
          {t("settingsSkills.install.runs", { command: installCommand(source, scope) })}
        </p>
        <Button
          variant="primary"
          disabled={source.trim() === "" || busy}
          onClick={() => onInstall(source.trim(), scope)}
        >
          {t("settingsSkills.install.submit")}
        </Button>
      </section>
    </div>
  );
}
