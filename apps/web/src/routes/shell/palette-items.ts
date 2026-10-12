import type { SessionSummary } from "@pap/contracts";
import {
  chordJoiner,
  chordTokens,
  type COMMANDS,
  type KeyNames,
  type PaletteItem,
  type Platform,
  type ResolvedRule,
} from "../../features/commands/index.ts";
import { SETTINGS_SECTIONS, type ItemRef, type Tab } from "../../features/workspace/index.ts";
import type { MessageKey, Translate } from "../../i18n/index.ts";
import { itemTitle } from "./item-title.ts";
import { basename, sessionLabel } from "./session-label.ts";

export const MAX_PALETTE_SESSIONS = 50;

interface PaletteItemsInput {
  readonly commands: typeof COMMANDS;
  has(id: string): boolean;
  readonly rules: readonly ResolvedRule[];
  readonly platform: Platform;
  readonly names: KeyNames;
  readonly tabs: readonly Tab[];
  readonly sessions: readonly SessionSummary[];
  readonly t: Translate;
  navigate(item: ItemRef): void;
  run(id: string): void;
}

/** The palette's rows: open tabs, commands that have a handler, the 50 newest sessions, settings sections. */
export function buildPaletteItems(input: PaletteItemsInput): PaletteItem[] {
  const { t, navigate } = input;
  const open = input.tabs.map((tab): PaletteItem => {
    const title = itemTitle(tab.item, input.sessions, t);
    return {
      id: `open:${tab.key}`,
      group: "open",
      title,
      searchTerms: [title],
      run: () => navigate(tab.item),
    };
  });
  const actions = input.commands
    .filter((command) => command.id !== "palette.toggle" && input.has(command.id))
    .map((command): PaletteItem => {
      const title = t(command.titleKey, command.titleVars);
      const rule = input.rules.findLast((candidate) => candidate.command === command.id);
      return {
        id: `action:${command.id}`,
        group: "actions",
        title,
        searchTerms: [title, command.id],
        ...(rule
          ? {
              chord: chordTokens(rule.chord, input.platform, input.names),
              chordJoiner: chordJoiner(input.platform),
            }
          : {}),
        run: () => input.run(command.id),
      };
    });
  const sessions = [...input.sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PALETTE_SESSIONS)
    .map((session): PaletteItem => {
      const title = sessionLabel(session) || t("shell.tab.session");
      return {
        id: `session:${session.id}`,
        group: "sessions",
        title,
        detail: session.cwd,
        searchTerms: [title, session.cwd, basename(session.cwd)],
        recency: session.updatedAt,
        run: () => navigate({ kind: "session", id: session.id }),
      };
    });
  const settings = SETTINGS_SECTIONS.map((section): PaletteItem => {
    const title = t(`commands.palette.settings.${section}` satisfies MessageKey);
    return {
      id: `settings:${section}`,
      group: "settings",
      title,
      searchTerms: [title, t("commands.palette.group.settings")],
      run: () => navigate({ kind: "settings", section }),
    };
  });
  return [...open, ...actions, ...sessions, ...settings];
}
