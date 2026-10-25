import type { CustomTheme } from "@pap/contracts";
import {
  Button,
  Chip,
  Heading,
  IconAppearance,
  IconButton,
  IconClose,
  IconCopy,
  IconExport,
  toast,
  useMediaQuery,
  type ThemeName,
} from "@pap/ui";
import { Menu } from "@pap/ui/overlays";
import { useContext, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { useAppearanceStore } from "./appearance-store.ts";
import { downloadThemeFile, presetRoles, type ThemeFileError } from "./theme-io.ts";
import { newThemeId } from "./theme-ids.ts";
import { COLUMN_QUERY, ThemeEditorSlot } from "./theme-editor-slot.ts";
import { ImportButton, ImportErrors } from "./ThemeImport.tsx";

type Draft = Omit<CustomTheme, "id">;
interface Editing {
  /** The theme being edited, or null for a new one. */
  readonly id: string | null;
  readonly initial: Draft;
}

const loadEditor = () => import("./ThemeEditor.tsx");
const THEME_LIMIT = 16;
const NAME_MAX = 64;
const PRESETS = ["night", "hc", "day"] as const satisfies readonly ThemeName[];
const state = () => useAppearanceStore.getState();

/** The custom theme library: list, Duplicate & edit from a preset, Import; the editor is its own lazy chunk. */
export function CustomThemes() {
  const t = useT();
  const hintId = useId();
  const themes = useAppearanceStore((s) => s.account.customThemes);
  const [editing, setEditing] = useState<Editing | null>(null);
  const wide = useMediaQuery(COLUMN_QUERY);
  const slot = useContext(ThemeEditorSlot);
  /** The right column when the page has one and there is room for it; otherwise the editor is a sheet. */
  const column = wide ? slot : null;
  // The column is not a modal, so nothing returns the focus when it closes: the control that opened it gets it back.
  const opener = useRef<HTMLElement | null>(null);
  const close = () => {
    setEditing(null);
    if (column !== null && opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  };
  const [importErrors, setImportErrors] = useState<readonly ThemeFileError[]>([]);
  const lazyText = useLazyFailureText();
  const full = themes.length >= THEME_LIMIT;
  // Safari does not focus a button on click, so the last button pressed in the list is the one to come back to.
  const pressed = useRef<HTMLElement | null>(null);
  const open = (next: Editing) => {
    setImportErrors([]);
    const focused = document.activeElement;
    if (editing === null) {
      opener.current =
        pressed.current ?? (focused instanceof HTMLElement && focused !== document.body ? focused : null);
    }
    setEditing(next);
  };
  const copyOf = (theme: Draft): Draft => ({
    ...theme,
    name: t("settings.theme.copyName", { name: theme.name }).slice(0, NAME_MAX),
  });
  const save = (theme: Draft) => {
    const { account, setAccount } = state();
    const id = editing?.id ?? null;
    const exists = id !== null && account.customThemes.some((one) => one.id === id);
    if (!exists) {
      // A new theme, or one deleted while its editor was open: it comes back as a new theme.
      if (account.customThemes.length >= THEME_LIMIT) {
        toast({ message: t("settings.theme.limit"), tone: "error" });
        return; // the editor stays open: nothing was saved
      }
      const taken = new Set(account.customThemes.map((one) => one.id));
      setAccount({
        ...account,
        customThemes: [...account.customThemes, { id: newThemeId(theme.name, taken), ...theme }],
      });
    } else {
      // A theme whose base changed can no longer serve the side it was chosen for: that side goes back to its preset.
      setAccount({
        ...account,
        customThemes: account.customThemes.map((one) => (one.id === id ? { id, ...theme } : one)),
        darkTheme: account.darkTheme === id && theme.base !== "night" ? "night" : account.darkTheme,
        lightTheme: account.lightTheme === id && theme.base !== "day" ? "day" : account.lightTheme,
      });
    }
    close();
  };
  const remove = (theme: CustomTheme) => {
    const { account, setAccount } = state();
    const index = account.customThemes.findIndex((one) => one.id === theme.id);
    if (index < 0) return;
    const darkReset = account.darkTheme === theme.id;
    const lightReset = account.lightTheme === theme.id;
    setAccount({
      ...account,
      customThemes: account.customThemes.filter((one) => one.id !== theme.id),
      darkTheme: darkReset ? "night" : account.darkTheme,
      lightTheme: lightReset ? "day" : account.lightTheme,
    });
    toast({
      message: t("settings.theme.deleted"),
      action: {
        label: t("settings.appearance.undo"),
        altText: t("settings.theme.undoAlt"),
        run: () => {
          const now = state().account;
          if (now.customThemes.length >= THEME_LIMIT) {
            toast({ message: t("settings.theme.limit"), tone: "error" });
            return;
          }
          // A theme created since may have taken the id: the restored one gets a fresh id and keeps its selection.
          const taken = new Set(now.customThemes.map((one) => one.id));
          const restored = taken.has(theme.id) ? { ...theme, id: newThemeId(theme.name, taken) } : theme;
          const list = [...now.customThemes];
          list.splice(Math.min(index, list.length), 0, restored);
          state().setAccount({
            ...now,
            customThemes: list,
            // The selection comes back only if nothing else was chosen for that side in the meantime.
            darkTheme: darkReset && now.darkTheme === "night" ? restored.id : now.darkTheme,
            lightTheme: lightReset && now.lightTheme === "day" ? restored.id : now.lightTheme,
          });
        },
      },
    });
  };
  const panel =
    editing === null ? null : (
      <LazyPanel
        load={loadEditor}
        open
        text={lazyText}
        onFailed={close}
        props={{
          layout: column === null ? ("dialog" as const) : ("column" as const),
          open: true,
          onOpenChange: (next: boolean) => {
            if (!next) close();
          },
          initial: editing.initial,
          onSave: save,
        }}
      />
    );
  const idle = (
    <section
      aria-label={t("settings.theme.editorTitle")}
      data-slot="theme-editor-idle"
      className="flex flex-col gap-s2"
    >
      <Heading level={3} variant="group">
        {t("settings.theme.editorTitle")}
      </Heading>
      <p className="text-ui text-muted">{t("settings.theme.columnHint")}</p>
    </section>
  );
  const editor = column === null ? panel : createPortal(panel ?? idle, column);
  const describedBy = full ? hintId : undefined;
  const fromPreset = (preset: ThemeName): Editing => ({
    id: null,
    initial: copyOf({
      name: t(`settings.appearance.preset.${preset}`),
      base: preset === "day" ? "day" : "night",
      roles: presetRoles(preset),
    }),
  });
  return (
    <div
      className="flex flex-col gap-s2"
      onClickCapture={(event) => {
        const button = (event.target as Element).closest("button");
        pressed.current = button instanceof HTMLElement ? button : null;
      }}
    >
      <Heading level={3} variant="group">
        {t("settings.theme.title")}
      </Heading>
      {themes.length === 0 ? <p className="text-ui text-muted">{t("settings.theme.empty")}</p> : null}
      <ul className="flex flex-col">
        {themes.map((theme) => (
          <li key={theme.id} className="flex items-center gap-s2 border-b border-border py-s1">
            <span className="min-w-0 flex-1 truncate text-ui text-fg">{theme.name}</span>
            <Chip
              tone="mut"
              label={t(theme.base === "night" ? "settings.theme.baseNight" : "settings.theme.baseDay")}
            />
            <IconButton
              icon={IconAppearance}
              label={t("settings.theme.edit", { name: theme.name })}
              onClick={() =>
                open({ id: theme.id, initial: { name: theme.name, base: theme.base, roles: theme.roles } })
              }
            />
            <IconButton
              icon={IconCopy}
              label={t("settings.theme.duplicate", { name: theme.name })}
              disabled={full}
              aria-describedby={describedBy}
              onClick={() => open({ id: null, initial: copyOf(theme) })}
            />
            <IconButton
              icon={IconExport}
              label={t("settings.theme.exportOne", { name: theme.name })}
              onClick={() => downloadThemeFile(theme)}
            />
            <IconButton
              icon={IconClose}
              label={t("settings.theme.delete", { name: theme.name })}
              onClick={() => remove(theme)}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-s2">
        {full ? (
          <Button variant="secondary" disabled aria-describedby={describedBy}>
            {t("settings.theme.duplicateEdit")}
          </Button>
        ) : (
          <Menu
            label={t("settings.theme.duplicateMenu")}
            closeLabel={t("ui.close")}
            trigger={<Button variant="secondary">{t("settings.theme.duplicateEdit")}</Button>}
            items={PRESETS.map((preset) => ({
              id: preset,
              label: t(`settings.appearance.preset.${preset}`),
              onSelect: () => open(fromPreset(preset)),
            }))}
          />
        )}
        <ImportButton
          disabled={full}
          onResult={(result) => {
            if (result.ok) open({ id: null, initial: result.theme });
            else setImportErrors(result.errors);
          }}
        />
      </div>
      {full ? (
        <p id={hintId} className="text-ui text-muted">
          {t("settings.theme.limit")}
        </p>
      ) : null}
      <ImportErrors errors={importErrors} />
      {editor}
    </div>
  );
}
