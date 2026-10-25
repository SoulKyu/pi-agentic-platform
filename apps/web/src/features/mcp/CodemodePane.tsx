import type { CodemodeSettings } from "@pap/contracts";
import { Button, Heading, InlineError, Switch, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";

export type CodemodePatch = {
  choice?: "automatic" | "always";
  mode?: "on" | "only";
  inlineBudget?: number | null;
};

const BUDGET_MAX = 1_000_000;

/** The budget field as the call wants it: `null` for empty, a whole number in range, or `undefined` when it is not valid. */
export function parseBudget(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,7}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value <= BUDGET_MAX ? value : undefined;
}

/**
 * Code mode as `settings.json` says it (M7R92): Automatic or Always on, the built-in tools beside it or replaced, the
 * inline budget. It reads the overview's `settings`; `null` means the file could not be read, and the controls then
 * say so instead of guessing.
 */
export function CodemodePane({
  settings,
  busy,
  builtinOff,
  onChange,
}: {
  readonly settings: CodemodeSettings | null;
  readonly busy: boolean;
  /** Pi's settings list `-builtin:codemode`: the built-in is off whatever the choice (MC46). */
  readonly builtinOff: boolean;
  onChange(patch: CodemodePatch): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const unreadable = settings === null;
  const shown =
    draft ?? (settings?.inlineBudget === null || settings === null ? "" : String(settings.inlineBudget));
  const parsed = parseBudget(shown);
  const dirty = draft !== null && parsed !== undefined && parsed !== (settings?.inlineBudget ?? null);
  return (
    <section className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("settingsMcp.codemode.title")}
      </Heading>
      {unreadable ? (
        <InlineError announce="background">{t("settingsMcp.codemode.unreadable")}</InlineError>
      ) : null}
      {builtinOff ? <p className="text-ui text-attn">{t("settingsMcp.codemode.builtinOff")}</p> : null}
      <Switch
        label={t("settingsMcp.codemode.always")}
        hint={t("settingsMcp.codemode.alwaysHint")}
        checked={settings?.choice === "always"}
        disabled={busy || unreadable || builtinOff}
        onChange={(on) => onChange({ choice: on ? "always" : "automatic" })}
      />
      <Switch
        label={t("settingsMcp.codemode.only")}
        hint={t("settingsMcp.codemode.onlyHint")}
        checked={settings?.mode === "only"}
        disabled={busy || unreadable}
        onChange={(on) => onChange({ mode: on ? "only" : "on" })}
      />
      <TextField
        label={t("settingsMcp.codemode.budget")}
        hint={t("settingsMcp.codemode.budgetHint")}
        value={shown}
        disabled={busy || unreadable}
        error={parsed === undefined ? t("settingsMcp.codemode.budgetBad") : null}
        onChange={setDraft}
      />
      <div>
        <Button
          disabled={busy || unreadable || !dirty}
          onClick={() => {
            if (parsed === undefined) return;
            onChange({ inlineBudget: parsed });
            setDraft(null);
          }}
        >
          {t("settingsMcp.codemode.saveBudget")}
        </Button>
      </div>
    </section>
  );
}
