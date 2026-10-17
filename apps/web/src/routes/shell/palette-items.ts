import type { AgentSummary, SessionSummary, TaskTrigger, TerminalView } from "@pap/contracts";
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
import type { ViewLabel } from "../../stores/view-labels-store.ts";
import { agentTarget, railDetail } from "../../features/agents/rail.vm.ts";
import { itemTitle } from "./item-title.ts";
import { laneStatusOf } from "../../lib/lane-sessions.ts";
import { isLiveLane, type LaneState } from "../../stores/lane-reducer.ts";
import { basename, sessionLabel } from "../../lib/session-label.ts";

export const MAX_PALETTE_SESSIONS = 50;

interface PaletteItemsInput {
  readonly commands: typeof COMMANDS;
  has(id: string): boolean;
  readonly rules: readonly ResolvedRule[];
  readonly platform: Platform;
  readonly names: KeyNames;
  readonly tabs: readonly Tab[];
  readonly sessions: readonly SessionSummary[];
  /** The labels of the loaded session views: titles a tab of a session the list lacks (M4R86). */
  readonly views: Readonly<Record<string, ViewLabel>>;
  /** The owner's terminals; the running ones are listed (M8R81). */
  readonly terminals?: readonly TerminalView[];
  /** The lane store and the shell sessions its status reads (M9R61); absent: no Lanes group. */
  readonly lanes?: LaneState;
  readonly laneFacts?: Iterable<{ cwd: string; status: string; needsInput: boolean }>;
  /** The owner's triggers (the tasks store); empty until the palette has opened the stream. */
  readonly triggers?: readonly TaskTrigger[];
  /** The project an empty trigger editor opens in; null while none is known (no entry then). */
  readonly newTriggerProject?: string | null;
  /** The owner's agents in creation order (the agents store): the Agents group (M11R109). */
  readonly agents?: readonly AgentSummary[];
  readonly t: Translate;
  navigate(item: ItemRef): void;
  run(id: string): void;
}

/** The palette's rows: open tabs, running terminals, commands that have a handler, the 50 newest sessions, settings sections. */
export function buildPaletteItems(input: PaletteItemsInput): PaletteItem[] {
  const { t, navigate } = input;
  const known = new Map(input.sessions.map((session) => [session.id, session]));
  const names = new Map([
    ...(input.triggers ?? []).map((trigger): [string, string] => [trigger.id, trigger.name]),
    ...(input.agents ?? []).map((agent): [string, string] => [`agent:${agent.id}`, agent.name]),
  ]);
  const open = input.tabs.map((tab): PaletteItem => {
    const title = itemTitle(tab.item, known, input.views, t, input.lanes, names);
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
  const facts = [...(input.laneFacts ?? [])];
  const lanes = [...(input.lanes?.lanes.values() ?? [])].filter(isLiveLane).map((lane): PaletteItem => {
    const title = lane.title || lane.branch;
    const word = t(`shell.lane.status.${laneStatusOf(lane, facts)}`);
    return {
      id: `lane:${lane.id}`,
      group: "lanes",
      title,
      detail: `${lane.branch} · ${word}`,
      searchTerms: [title, lane.branch, word],
      recency: lane.createdAt,
      run: () => navigate({ kind: "lane", id: lane.id }),
    };
  });
  const agents = (input.agents ?? []).map((agent): PaletteItem => {
    // An unreadable profile opens Settings, not the tab: the row says so.
    const title = t(agent.unreadable ? "commands.palette.fixAgent" : "commands.palette.agent", {
      name: agent.name,
    });
    return {
      id: `agent:${agent.id}`,
      group: "agents",
      title,
      detail: railDetail(agent, t),
      searchTerms: [title, agent.name],
      run: () => navigate(agentTarget(agent)),
    };
  });
  const newAgent: PaletteItem[] = input.has("agents.new")
    ? [
        {
          id: "agents:new",
          group: "agents",
          title: t("commands.palette.newAgent"),
          searchTerms: [t("commands.palette.newAgent"), t("commands.palette.group.agents")],
          run: () => input.run("agents.new"),
        },
      ]
    : [];
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
  const terminals = (input.terminals ?? [])
    .filter((terminal) => terminal.status === "running")
    .map((terminal): PaletteItem => {
      const folder = basename(terminal.cwd);
      return {
        id: `terminal:${terminal.id}`,
        group: "open",
        title: t("commands.palette.terminal", { folder }),
        detail: terminal.cwd,
        searchTerms: [t("commands.palette.terminal", { folder }), terminal.cwd, folder],
        run: () => navigate({ kind: "terminal", id: terminal.id }),
      };
    });
  const board = (id: string, title: string, item: ItemRef, searchTerms: string[] = [title]): PaletteItem => ({
    id,
    group: "tasks",
    title,
    searchTerms,
    run: () => navigate(item),
  });
  const tasks = [
    board("tasks:board", t("commands.palette.tasks"), { kind: "tasks" }),
    ...(input.newTriggerProject
      ? [
          board("tasks:new-trigger", t("commands.palette.newTrigger"), {
            kind: "trigger",
            id: `new:${input.newTriggerProject}`,
          }),
        ]
      : []),
    ...(input.triggers ?? []).map((trigger) =>
      board(
        `trigger:${trigger.id}`,
        t("commands.palette.trigger", { name: trigger.name }),
        { kind: "trigger", id: trigger.id },
        [t("commands.palette.trigger", { name: trigger.name }), trigger.name],
      ),
    ),
  ];
  return [
    ...open,
    ...terminals,
    ...actions,
    ...agents,
    ...newAgent,
    ...lanes,
    ...sessions,
    ...tasks,
    ...settings,
  ];
}
