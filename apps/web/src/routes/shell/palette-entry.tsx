import type { AgentSummary, ShellSession, TaskTrigger, TerminalView } from "@pap/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  COMMANDS,
  detectPlatform,
  hasCommand,
  keyNames,
  runCommand,
  type ResolvedRule,
} from "../../features/commands/index.ts";
import CommandPalette from "../../features/commands/palette/CommandPalette.tsx";
import { activeTab, pathOfItem, useWorkspaceStore, type Tab } from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import type { LaneState } from "../../stores/lane-reducer.ts";
import type { ViewLabel } from "../../stores/view-labels-store.ts";
import { buildPaletteItems } from "./palette-items.ts";
import { isBoxPath } from "../../stores/box-path.ts";
import { useRole } from "../../lib/role-context.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { placeOf } from "./surface.ts";
import { go } from "./tab-actions.ts";

/** What the host already holds; the rows are built from it here, when the palette opens. */
export interface PaletteSource {
  readonly rules: readonly ResolvedRule[];
  readonly tabs: readonly Tab[];
  readonly sessions: ReadonlyMap<string, ShellSession>;
  readonly views: Readonly<Record<string, ViewLabel>>;
  readonly lanes: LaneState;
  readonly terminals: readonly TerminalView[];
  readonly triggers: readonly TaskTrigger[];
  readonly newTriggerProject: string | null;
  readonly agents: readonly AgentSummary[];
}

interface PaletteEntryProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  openSession(sessionId: string): void;
  readonly search: { readonly projectId: string | null; readonly projectName: string | null } | null;
  readonly source: PaletteSource;
}

/** The palette chunk's entry: `buildPaletteItems` lives here, so none of the row building is in the initial bundle. */
export default function PaletteEntry({ source, search, ...rest }: PaletteEntryProps) {
  const t = useT();
  const navigate = useNavigate();
  const role = useRole();
  const view = useShellStore((state) => state.view);
  // A member has a terminal only in a box: the active session's, and the running ones inside a box project.
  const active = useWorkspaceStore((state) => activeTab(state.ws));
  const boxSession = active?.item.kind === "session" && placeOf(view, active.item.id)?.box === true;
  const items = useMemo(
    () =>
      search !== null
        ? []
        : buildPaletteItems({
            commands: COMMANDS,
            has: (id: string) =>
              hasCommand(id) && (id !== "session.openTerminal" || role === "owner" || boxSession),
            rules: source.rules,
            platform: detectPlatform(),
            names: keyNames(t),
            tabs: source.tabs,
            // Archived sessions belong to the Archived shelf and to search; they take no palette slot.
            sessions: [...source.sessions.values()].filter((session) => session.archivedAt === null),
            views: source.views,
            lanes: source.lanes,
            laneFacts: source.sessions.values(),
            terminals:
              role === "owner"
                ? source.terminals
                : source.terminals.filter((terminal) => isBoxPath(view, terminal.cwd)),
            triggers: source.triggers,
            newTriggerProject: source.newTriggerProject,
            agents: source.agents,
            role,
            t,
            navigate: (item) => go(navigate, pathOfItem(item)),
            run: (id) => {
              try {
                runCommand(id);
              } catch {
                reportClientIssue("command_failed");
              }
            },
          }),
    [search, source, t, navigate, role, view, boxSession],
  );
  return <CommandPalette {...rest} search={search} items={items} />;
}
