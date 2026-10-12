import { THEME_ROLES, type CustomTheme } from "@pap/contracts";
import { Button, Chip, Message, Segmented, TextField } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { getLocale, useT } from "../../i18n/index.ts";
import { deriveTheme, roleChecks, tokenVars, type RoleCheck } from "./derive.ts";
import { downloadThemeFile, type ThemeFileError } from "./theme-io.ts";
import { newThemeId } from "./theme-ids.ts";
import { ImportButton, ImportErrors } from "./ThemeImport.tsx";

type Role = (typeof THEME_ROLES)[number];
type Draft = Omit<CustomTheme, "id">;
const HEX = /^#[0-9a-fA-F]{6}$/;
const NAME_MAX = 64;
const BASES = ["night", "day"] as const;
const FILLS = ["agent", "you", "attn"] as const;

/** One decimal, rounded down: a ratio just under 4.5 never shows as 4.5. */
const formatRatio = (ratio: number): string =>
  new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
    Math.floor(ratio * 10) / 10,
  );

export interface ThemeEditorProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  readonly initial: Draft;
  onSave(theme: Draft): void;
}

/** Eight roles, the WCAG ratio of each, a live preview, and a confirmation before saving below AA. */
export default function ThemeEditor({ open, onOpenChange, initial, onSave }: ThemeEditorProps) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [base, setBase] = useState<Draft["base"]>(initial.base);
  const [typed, setTyped] = useState<Record<Role, string>>(initial.roles);
  const [importErrors, setImportErrors] = useState<readonly ThemeFileError[]>([]);
  const [confirming, setConfirming] = useState(false);
  const hexOk = (role: Role) => HEX.test(typed[role]);
  // An unfinished hex never reaches the derivation or the preview: the last good value stands in.
  const roles = Object.fromEntries(
    THEME_ROLES.map((role) => [role, hexOk(role) ? typed[role] : initial.roles[role]]),
  ) as Record<Role, string>;
  const trimmed = name.trim();
  const nameOk = trimmed.length >= 1 && trimmed.length <= NAME_MAX;
  const valid = nameOk && THEME_ROLES.every(hexOk);
  const draft: CustomTheme = { id: "preview", name: trimmed, base, roles };
  const checks = roleChecks(draft);
  const failing = valid ? checks.filter((check) => !check.passes) : [];
  const label = (role: string): string =>
    role.endsWith("-fill")
      ? t(`settings.theme.fill.${role.slice(0, -5) as (typeof FILLS)[number]}`)
      : t(`settings.theme.role.${role as Role}`);
  const save = () => {
    if (!valid) return;
    if (failing.length > 0) setConfirming(true);
    else onSave({ name: trimmed, base, roles: typed });
  };
  const verdict = (check: RoleCheck | undefined) =>
    check === undefined ? null : (
      <span className="flex items-center gap-s1">
        <Chip
          tone={check.passes ? "ok" : "att"}
          label={check.passes ? t("settings.theme.aa") : t("settings.theme.belowAa")}
        />
        <span data-slot="theme-ratio" className="tabular-nums text-ui text-muted">
          {t("settings.theme.ratio", { value: formatRatio(check.ratio) })}
        </span>
        {check.adjusted === null ? null : (
          <span className="text-ui text-muted">
            {t("settings.theme.adjusted", { color: check.adjusted })}
          </span>
        )}
      </span>
    );
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("settings.theme.editorTitle")}
        closeLabel={t("ui.close")}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={!valid}
              onClick={() => downloadThemeFile({ ...draft, id: newThemeId(trimmed, new Set()) })}
            >
              {t("settings.theme.export")}
            </Button>
            <Button variant="primary" disabled={!valid} onClick={save}>
              {t("settings.theme.save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-s3 p-s3">
          <TextField
            label={t("settings.theme.name")}
            value={name}
            error={nameOk ? null : t("settings.theme.nameInvalid")}
            onChange={setName}
          />
          <Segmented<Draft["base"]>
            label={t("settings.theme.base")}
            value={base}
            options={BASES.map((value) => ({ value, label: t(`settings.appearance.mode.${value}`) }))}
            onChange={setBase}
          />
          <ImportButton
            onResult={(result) => {
              setImportErrors(result.ok ? [] : result.errors);
              if (!result.ok) return;
              setName(result.theme.name);
              setBase(result.theme.base);
              setTyped(result.theme.roles);
            }}
          />
          <ImportErrors errors={importErrors} />
          {THEME_ROLES.map((role) => (
            <div key={role} data-role={role} className="flex flex-wrap items-end gap-s2">
              <input
                type="color"
                aria-label={t("settings.theme.picker", { role: label(role) })}
                value={roles[role].toLowerCase()}
                onChange={(event) => setTyped({ ...typed, [role]: event.target.value })}
                className="size-control shrink-0 rounded-sm border border-control-border bg-bg p-0 focus-ring pointer-coarse:size-11"
              />
              <TextField
                label={label(role)}
                value={typed[role]}
                error={hexOk(role) ? null : t("settings.theme.hexInvalid")}
                onChange={(value) => setTyped({ ...typed, [role]: value })}
              />
              {verdict(checks.find((check) => check.role === role))}
            </div>
          ))}
          <h3 className="label-hud text-muted">{t("settings.theme.fills")}</h3>
          {FILLS.map((fill) => (
            <div key={fill} data-role={`${fill}-fill`} className="flex flex-wrap items-center gap-s2">
              <span className="text-ui text-fg">{label(`${fill}-fill`)}</span>
              {verdict(checks.find((check) => check.role === `${fill}-fill`))}
            </div>
          ))}
          <section
            aria-label={t("settings.theme.preview")}
            data-slot="theme-preview"
            data-theme={base}
            style={tokenVars(deriveTheme(draft))}
            className="flex flex-col gap-s2 rounded-md border border-border bg-bg p-s3"
          >
            <Message author="you" label={t("settings.appearance.sample.youLabel")}>
              {t("settings.theme.previewYou")}
            </Message>
            <Message author="agent" label={t("settings.appearance.sample.agentLabel")}>
              {t("settings.theme.previewAgent")}
            </Message>
            <div>
              <Button variant="primary">{t("settings.theme.previewButton")}</Button>
            </div>
          </section>
        </div>
      </Dialog>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("settings.theme.confirmTitle")}
        closeLabel={t("ui.close")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t("settings.theme.keepEditing")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(false);
                onSave({ name: trimmed, base, roles: typed });
              }}
            >
              {t("settings.theme.saveAnyway")}
            </Button>
          </>
        }
      >
        <div data-slot="theme-confirm" className="flex flex-col gap-s2 p-s3 text-ui">
          <p>{t("settings.theme.confirmBody")}</p>
          <ul className="list-disc pl-s4">
            {failing.map((check) => (
              <li key={check.role}>
                {label(check.role)}{" "}
                <span className="tabular-nums">
                  {t("settings.theme.ratio", { value: formatRatio(check.ratio) })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Dialog>
    </>
  );
}
