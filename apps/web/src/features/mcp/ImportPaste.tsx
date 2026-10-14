import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { IMPORT_LIMITS, parsePaste, previewOf, type Candidate } from "./import.ts";
import { escapeHidden } from "./mcp.vm.ts";

type Outcome = "none" | "tooBig" | "cut" | null;

/**
 * The paste importer (M7R101): the text is read here, in the browser, on Read. Each server is listed masked (env and
 * header values are never shown) and nothing is sent until Add. Every string from the paste is rendered as React text,
 * hidden characters written out (M7R86).
 */
export function ImportPaste({
  candidates,
  busy,
  onCandidates,
  onAdd,
}: {
  readonly candidates: readonly Candidate[];
  readonly busy: boolean;
  onCandidates(list: Candidate[]): void;
  onAdd(items: readonly Candidate[]): void;
}) {
  const t = useT();
  const [pasted, setPasted] = useState("");
  const [ignored, setIgnored] = useState<readonly string[]>([]);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const read = () => {
    const result = parsePaste(pasted);
    onCandidates(result.candidates);
    setIgnored(result.ignored);
    // The entries are kept in the list: the raw text, which may hold secrets, goes as soon as it is read (M3).
    if (result.candidates.length > 0) setPasted("");
    setOutcome(
      result.tooLarge ? "tooBig" : result.cut ? "cut" : result.candidates.length === 0 ? "none" : null,
    );
  };
  return (
    <section className="flex flex-col items-start gap-s2">
      <TextField
        label={t("settingsMcp.add.paste")}
        hint={t("settingsMcp.add.pasteHint")}
        value={pasted}
        multiline
        mono
        rows={5}
        autoComplete="off"
        onChange={setPasted}
      />
      <Button onClick={read} disabled={pasted.trim() === ""}>
        {t("settingsMcp.add.read")}
      </Button>
      {outcome === "none" ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsMcp.add.none")}
        </p>
      ) : null}
      {outcome === "tooBig" ? (
        <p role="alert" className="text-ui text-attn">
          {t("settingsMcp.add.tooBig")}
        </p>
      ) : null}
      {outcome === "cut" ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsMcp.add.cut", { max: IMPORT_LIMITS.servers })}
        </p>
      ) : null}
      {candidates.length > 0 && ignored.length > 0 ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsMcp.add.ignored", { flags: escapeHidden(ignored.join(", ")) })}
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <>
          <ul aria-label={t("settingsMcp.add.candidates")} className="flex w-full flex-col gap-s2">
            {candidates.map((one) => (
              <CandidateRow key={one.name} candidate={one} />
            ))}
          </ul>
          <Button variant="primary" disabled={busy} onClick={() => onAdd(candidates)}>
            {t("settingsMcp.add.addCount", { count: candidates.length })}
          </Button>
        </>
      ) : null}
    </section>
  );
}

function CandidateRow({ candidate }: { readonly candidate: Candidate }) {
  const t = useT();
  const view = previewOf(candidate.entry);
  const pairs = (title: string, list: typeof view.env) =>
    list.length === 0 ? null : (
      <p className="text-ui text-muted">
        {title}: {list.map((pair) => `${escapeHidden(pair.name)} ${pair.value}`).join(", ")}
      </p>
    );
  return (
    <li className="flex flex-col gap-s1 rounded-sm border border-border p-s2">
      <p className="text-ui text-fg">{escapeHidden(candidate.name)}</p>
      <p className="break-all font-mono text-ui text-muted">{escapeHidden(view.target)}</p>
      {pairs(t("settingsMcp.add.env.title"), view.env)}
      {pairs(t("settingsMcp.add.headers.title"), view.headers)}
    </li>
  );
}
