import type { KeybindingRule } from "@pap/contracts";
import type { MessageKey } from "../../i18n/index.ts";

/** Read by Task 17a's context; `panelFocus` and `overlayOpen` follow agreement 7 (owner R3-6), `treeOpen` M3-RT-30. */
export const CONTEXT_KEYS = [
  "editableFocus",
  "dialogOpen",
  "overlayOpen",
  "panelFocus",
  "inlineEditFocus",
  "paletteOpen",
  "treeOpen",
  "sessionFocus",
  "mobile",
] as const;

export type CommandGroup = "navigation" | "tabs" | "panes" | "session" | "agents" | "app";

export interface CommandSpec {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly titleVars?: Readonly<Record<string, number>>;
  readonly group: CommandGroup;
}

export const COMMANDS: readonly CommandSpec[] = [
  { id: "palette.toggle", titleKey: "commands.palette.toggle", group: "navigation" },
  { id: "drawer.tree.toggle", titleKey: "commands.drawer.tree.toggle", group: "navigation" },
  { id: "drawer.inbox.toggle", titleKey: "commands.drawer.inbox.toggle", group: "navigation" },
  { id: "settings.open", titleKey: "commands.settings.open", group: "navigation" },
  { id: "tasks.open", titleKey: "commands.tasks.open", group: "navigation" },
  { id: "shortcuts.help", titleKey: "commands.shortcuts.help", group: "app" },
  { id: "session.new", titleKey: "commands.session.new", group: "session" },
  { id: "lanes.new", titleKey: "commands.lanes.new", group: "session" },
  { id: "session.stop", titleKey: "commands.session.stop", group: "session" },
  { id: "session.sendOther", titleKey: "commands.session.sendOther", group: "session" },
  { id: "session.showChanges", titleKey: "commands.session.showChanges", group: "session" },
  { id: "session.openTerminal", titleKey: "commands.session.openTerminal", group: "session" },
  { id: "session.showFiles", titleKey: "commands.session.showFiles", group: "session" },
  { id: "tab.next", titleKey: "commands.tab.next", group: "tabs" },
  { id: "tab.prev", titleKey: "commands.tab.prev", group: "tabs" },
  { id: "tab.close", titleKey: "commands.tab.close", group: "tabs" },
  { id: "pane.split", titleKey: "commands.pane.split", group: "panes" },
  { id: "pane.close", titleKey: "commands.pane.close", group: "panes" },
  { id: "agent.nextUnread", titleKey: "commands.agent.nextUnread", group: "agents" },
  { id: "agent.prevUnread", titleKey: "commands.agent.prevUnread", group: "agents" },
  // One title with the agent's position as a variable ("Go to agent {n}"), not nine keys.
  ...Array.from({ length: 9 }, (_, i): CommandSpec => ({
    id: `agent.goto.${i + 1}`,
    titleKey: "commands.agent.goto",
    titleVars: { n: i + 1 },
    group: "agents",
  })),
  { id: "appearance.cycleMode", titleKey: "commands.appearance.cycleMode", group: "app" },
  { id: "auth.signOut", titleKey: "commands.auth.signOut", group: "app" },
];

// pi-web's shortcuts (spec C §7.3) plus the shell's; chords browsers keep are avoided (Review Focus 4). Every chord
// stays out of an extension's terminal-input panel (`!panelFocus`); Escape also leaves an open menu, select or popover
// to Radix (`!overlayOpen`) and an inline edit to itself (`!inlineEditFocus`), so it stops the run only when none holds
// (agreement 7, owner R3-6).
export const DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [
  { key: "mod+k", command: "palette.toggle", when: "!panelFocus" },
  { key: "mod+b", command: "drawer.tree.toggle", when: "!panelFocus && (!dialogOpen || treeOpen)" },
  { key: "mod+,", command: "settings.open", when: "!panelFocus && !dialogOpen" },
  { key: "?", command: "shortcuts.help", when: "!panelFocus && !editableFocus && !dialogOpen" },
  { key: "ctrl+alt+n", command: "session.new", when: "!panelFocus && !dialogOpen" },
  { key: "mod+shift+l", command: "lanes.new", when: "!panelFocus && !dialogOpen" },
  {
    key: "escape",
    command: "session.stop",
    when: "sessionFocus && !panelFocus && !inlineEditFocus && !overlayOpen && !dialogOpen && !paletteOpen",
  },
  {
    key: "mod+shift+enter",
    command: "session.sendOther",
    when: "sessionFocus && !panelFocus && !inlineEditFocus && !overlayOpen && !dialogOpen",
  },
  {
    key: "alt+shift+arrowright",
    command: "tab.next",
    when: "!panelFocus && !editableFocus && !dialogOpen",
  },
  {
    key: "alt+shift+arrowleft",
    command: "tab.prev",
    when: "!panelFocus && !editableFocus && !dialogOpen",
  },
  { key: "alt+w", command: "tab.close", when: "!panelFocus && !editableFocus && !dialogOpen" },
  { key: "mod+\\", command: "pane.split", when: "!panelFocus && !dialogOpen && !mobile" },
  { key: "alt+arrowdown", command: "agent.nextUnread", when: "!panelFocus && !dialogOpen" },
  { key: "alt+arrowup", command: "agent.prevUnread", when: "!panelFocus && !dialogOpen" },
  ...Array.from({ length: 9 }, (_, i) => ({
    key: `ctrl+alt+${i + 1}`,
    command: `agent.goto.${i + 1}`,
    when: "!panelFocus && !dialogOpen",
  })),
];

export const KNOWN_COMMANDS: ReadonlySet<string> = new Set(COMMANDS.map((command) => command.id));
