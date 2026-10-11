import { Button, Collapsible, TextField } from "@pap/ui";
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

/** The user's rules as text: edit and apply, import a file, export a file. Every path ends in the same parser. */
export function KeybindingsJson({ platform }: { readonly platform: Platform }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [result, setResult] = useState<KeybindingsFileResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const user = useKeybindingsStore((state) => state.user);
  const saved = exportKeybindingsFile(user);

  const apply = (outcome: KeybindingsFileResult) => {
    setResult(outcome);
    if (!outcome.ok) return;
    useKeybindingsStore.getState().setUser(outcome.rules);
    setDraft(null);
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
          value={draft ?? saved}
          onChange={setDraft}
        />
        <div className="flex flex-wrap gap-s2">
          <Button variant="primary" onClick={() => apply(parseKeybindingsFile(draft ?? saved, platform))}>
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
                .then(apply)
                .catch(() => reportClientIssue("command_failed"));
            }}
          />
        </div>
        <Outcome result={result} />
      </div>
    </Collapsible>
  );
}

/** What the text got wrong, entry by entry: fixed sentences and numbers only, nothing the file said. */
function Outcome({ result }: { readonly result: KeybindingsFileResult | null }) {
  const t = useT();
  if (result === null) return null;
  const lines = result.ok
    ? result.issues.map((issue) =>
        t(`settings.shortcuts.json.issue.${issue.problem}`, { index: issue.index + 1 }),
      )
    : [t(`settings.shortcuts.json.error.${result.error}`)];
  if (lines.length === 0) return null;
  return (
    <div data-slot="shortcuts-json-issues" role="alert" className="flex flex-col gap-s1 text-ui text-attn">
      {result.ok ? <p>{t("settings.shortcuts.json.notApplied")}</p> : null}
      <ul className="list-disc pl-s4">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      {result.ok && result.omittedIssues > 0 ? (
        <p>{t("settings.shortcuts.json.more", { count: result.omittedIssues })}</p>
      ) : null}
    </div>
  );
}
