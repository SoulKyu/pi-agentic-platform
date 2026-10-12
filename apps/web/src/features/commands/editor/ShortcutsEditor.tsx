import { KEY_NONE, type KeybindingRule } from "@pap/contracts";
import { Button, TextField, toast } from "@pap/ui";
import { useState } from "react";
import { useLocale, useT, type MessageKey } from "../../../i18n/index.ts";
import type { AccountStatus } from "../../../lib/account-setting.ts";
import { COMMANDS, DEFAULT_KEYBINDINGS, type CommandGroup } from "../defaults.ts";
import type { Platform } from "../keys.ts";
import { detectPlatform } from "../labels.ts";
import { useKeybindingsStore } from "../keybindings-store.ts";
import { conflictsOf, isReserved } from "../resolve.ts";
import { KeybindingsJson } from "./KeybindingsJson.tsx";
import { ShortcutRow } from "./ShortcutRow.tsx";

const MAX_USER_RULES = 256;

const GROUPS: readonly { readonly id: CommandGroup; readonly titleKey: MessageKey }[] = [
  { id: "navigation", titleKey: "commands.group.navigation" },
  { id: "tabs", titleKey: "commands.group.tabs" },
  { id: "panes", titleKey: "commands.group.panes" },
  { id: "session", titleKey: "commands.group.session" },
  { id: "agents", titleKey: "commands.group.agents" },
  { id: "app", titleKey: "commands.group.app" },
];

/** `local` says nothing: the account document knows of no saved copy. */
const STATUS_LINES: Record<AccountStatus, MessageKey | null> = {
  local: null,
  saving: "settings.shortcuts.status.saving",
  saved: "settings.shortcuts.status.saved",
  error: "settings.shortcuts.status.error",
  "load-error": "settings.shortcuts.status.loadError",
};

const isNone = (rule: KeybindingRule) => rule.key.trim().toLowerCase() === KEY_NONE;
const without = (user: readonly KeybindingRule[], command: string) =>
  user.filter((rule) => rule.command !== command);
const hasDefault = (command: string) => DEFAULT_KEYBINDINGS.some((rule) => rule.command === command);

/** The recorded chord replaces the user's rules of the command and keeps the `when` of its default (M3R120). */
function rebound(user: readonly KeybindingRule[], command: string, chord: string): KeybindingRule[] {
  const when = DEFAULT_KEYBINDINGS.find((rule) => rule.command === command)?.when;
  return [
    ...without(user, command),
    when === undefined ? { key: chord, command } : { key: chord, command, when },
  ];
}

/** `none` replaces the default and binds nothing; a command with no default only loses its user rules. */
function removed(user: readonly KeybindingRule[], command: string): KeybindingRule[] {
  const rest = without(user, command);
  return hasDefault(command) ? [...rest, { key: KEY_NONE, command }] : rest;
}

/** Settings › Keyboard shortcuts: search, one row per command, and the JSON view of the user's rules. */
export function ShortcutsEditor({ platform }: { readonly platform?: Platform }) {
  const t = useT();
  const locale = useLocale();
  const [detected] = useState(() => detectPlatform());
  const chosenPlatform = platform ?? detected;
  const [query, setQuery] = useState("");
  const [tooMany, setTooMany] = useState(false);
  const user = useKeybindingsStore((state) => state.user);
  const rules = useKeybindingsStore((state) => state.rules);
  const status = useKeybindingsStore((state) => state.status);
  const line = STATUS_LINES[status];
  const conflicts = conflictsOf(rules, chosenPlatform);
  const titleOf = (id: string) => {
    const spec = COMMANDS.find((candidate) => candidate.id === id);
    return spec === undefined ? id : t(spec.titleKey, spec.titleVars);
  };
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  const needle = query.trim().toLowerCase();

  const save = (next: readonly KeybindingRule[]) => {
    const tooLong = next.length > MAX_USER_RULES;
    setTooMany(tooLong);
    if (!tooLong) useKeybindingsStore.getState().setUser(next);
  };
  const resetAll = () => {
    const previous = useKeybindingsStore.getState().user;
    save([]);
    toast({
      message: t("settings.shortcuts.resetAllDone"),
      action: {
        label: t("settings.shortcuts.undo"),
        altText: t("settings.shortcuts.undoAlt"),
        run: () => save(previous),
      },
    });
  };

  const sections = GROUPS.map((group) => ({
    ...group,
    specs: COMMANDS.filter(
      (spec) =>
        spec.group === group.id &&
        (needle === "" ||
          t(spec.titleKey, spec.titleVars).toLowerCase().includes(needle) ||
          spec.id.toLowerCase().includes(needle)),
    ),
  })).filter((section) => section.specs.length > 0);

  return (
    <div className="flex flex-col gap-s4">
      <header className="flex flex-wrap items-center justify-between gap-s2">
        <h2 className="text-h2 text-fg">{t("settings.shortcuts.title")}</h2>
        <Button variant="secondary" disabled={user.length === 0} onClick={resetAll}>
          {t("settings.shortcuts.resetAll")}
        </Button>
      </header>
      <p role="status" data-slot="shortcuts-status" className="text-ui text-muted">
        {line === null ? "" : t(line)}
      </p>
      {tooMany ? (
        <p role="alert" className="text-ui text-attn">
          {t("settings.shortcuts.tooMany")}
        </p>
      ) : null}
      <TextField label={t("settings.shortcuts.search")} value={query} onChange={setQuery} />
      {sections.length === 0 ? <p className="text-ui text-muted">{t("settings.shortcuts.empty")}</p> : null}
      {sections.map((section) => (
        <section key={section.id} data-group={section.id} className="flex flex-col gap-s1">
          <h3 className="text-label text-muted">{t(section.titleKey)}</h3>
          <ul className="flex flex-col">
            {section.specs.map((spec) => {
              const index = rules.findLastIndex((candidate) => candidate.command === spec.id);
              const rule = index === -1 ? null : (rules[index] ?? null);
              const others = conflicts.get(index);
              return (
                <ShortcutRow
                  key={spec.id}
                  spec={spec}
                  rule={rule}
                  custom={
                    rule?.source === "user" ||
                    user.some((entry) => entry.command === spec.id && isNone(entry))
                  }
                  conflicts={others === undefined ? null : list.format(others.map(titleOf))}
                  reserved={rule !== null && isReserved(rule.chord, chosenPlatform)}
                  platform={chosenPlatform}
                  onRecord={(chord) => save(rebound(user, spec.id, chord))}
                  onReset={() => save(without(user, spec.id))}
                  onRemove={() => save(removed(user, spec.id))}
                />
              );
            })}
          </ul>
        </section>
      ))}
      <KeybindingsJson platform={chosenPlatform} />
    </div>
  );
}
