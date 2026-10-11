import type { KeybindingRule } from "@pap/contracts";
import { Button, Collapsible, TextField, toast } from "@pap/ui";
import { useRef, useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { downloadJsonFile } from "../../../lib/download-file.ts";
import { reportClientIssue } from "../../../lib/report.ts";
import type { Platform } from "../keys.ts";
import { useKeybindingsStore } from "../keybindings-store.ts";
import {
  exportKeybindingsFile,
  parseKeybindingsFile,
  readKeybindingsFile,
  type KeybindingsFileResult,
} from "./keybindings-io.ts";

interface Draft {
  readonly text: string;
  /** The user rules the text was made from: the text is shown only while they are the rules in force. */
  readonly base: readonly KeybindingRule[];
}
interface Report {
  readonly outcome: KeybindingsFileResult;
  readonly source: "text" | "file";
  readonly refused: boolean;
  /** The rules in force when the report was made (after the apply, for an applied one). */
  readonly base: readonly KeybindingRule[];
}

/** The user's rules as text: edit and apply, import a file, export a file. Every path ends in the same parser. */
export function KeybindingsJson({ platform }: { readonly platform: Platform }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const user = useKeybindingsStore((state) => state.user);
  const saved = exportKeybindingsFile(user);
  const shown = draft !== null && draft.base === user ? draft.text : saved;
  const visible = report !== null && report.base === user ? report : null;

  const apply = (outcome: KeybindingsFileResult, source: Report["source"], text: string | null) => {
    const store = useKeybindingsStore.getState();
    const previous = store.user;
    if (!outcome.ok) {
      setReport({ outcome, source, refused: false, base: previous });
      return;
    }
    // A list with entries but none valid would wipe the custom bindings by accident: apply nothing.
    const refused = outcome.rules.length === 0 && outcome.issues.length + outcome.omittedIssues > 0;
    if (refused && previous.length > 0) {
      setReport({ outcome, source, refused: true, base: previous });
      return;
    }
    store.setUser(outcome.rules);
    setDraft(text === null ? null : { text, base: outcome.rules });
    setReport({ outcome, source, refused: false, base: outcome.rules });
    if (previous.length > 0 && exportKeybindingsFile(previous) !== exportKeybindingsFile(outcome.rules))
      toast({
        message: t("settings.shortcuts.json.applied"),
        action: {
          label: t("settings.shortcuts.undo"),
          altText: t("settings.shortcuts.json.undoAlt"),
          run: () => useKeybindingsStore.getState().setUser(previous),
        },
      });
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      trigger={<span className="label-hud text-muted">{t("settings.shortcuts.json.edit")}</span>}
    >
      <div className="flex flex-col gap-s2 pt-s2">
        <TextField
          multiline
          label={t("settings.shortcuts.json.label")}
          value={shown}
          onChange={(text) => {
            setDraft({ text, base: user });
            setReport(null);
          }}
        />
        <div className="flex flex-wrap gap-s2">
          <Button
            variant="primary"
            onClick={() => apply(parseKeybindingsFile(shown, platform), "text", shown)}
          >
            {t("settings.shortcuts.json.apply")}
          </Button>
          <Button variant="secondary" onClick={() => input.current?.click()}>
            {t("settings.shortcuts.json.import")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => downloadJsonFile("pap-keybindings.json", exportKeybindingsFile(user))}
          >
            {t("settings.shortcuts.json.export")}
          </Button>
          <input
            ref={input}
            type="file"
            hidden
            accept="application/json,.json"
            aria-label={t("settings.shortcuts.json.import")}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file === undefined) return;
              readKeybindingsFile(file, platform)
                .then((outcome) => apply(outcome, "file", null))
                .catch(() => reportClientIssue("command_failed"));
            }}
          />
        </div>
        <Outcome report={visible} />
      </div>
    </Collapsible>
  );
}

/** What the text got wrong, entry by entry: fixed sentences and numbers only, nothing the file said. */
function Outcome({ report }: { readonly report: Report | null }) {
  const t = useT();
  if (report === null) return null;
  const { outcome } = report;
  const lines = outcome.ok
    ? outcome.issues.map((issue) =>
        t(`settings.shortcuts.json.issue.${issue.problem}`, { index: issue.index + 1 }),
      )
    : [t(`settings.shortcuts.json.error.${outcome.error}`)];
  if (lines.length === 0) return null;
  const heading = report.refused
    ? "settings.shortcuts.json.nothingApplied"
    : report.source === "file"
      ? "settings.shortcuts.json.fileNotApplied"
      : "settings.shortcuts.json.notApplied";
  return (
    <div data-slot="shortcuts-json-issues" role="alert" className="flex flex-col gap-s1 text-ui text-attn">
      {outcome.ok ? <p>{t(heading)}</p> : null}
      <ul className="list-disc pl-s4">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      {outcome.ok && outcome.omittedIssues > 0 ? (
        <p>{t("settings.shortcuts.json.more", { count: outcome.omittedIssues })}</p>
      ) : null}
    </div>
  );
}
