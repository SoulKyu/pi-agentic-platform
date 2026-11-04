import { LoadingLine, type AvatarStyle } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { AgentAvatar } from "../../features/agents/AgentAvatar.tsx";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import { runCommand } from "../../features/commands/index.ts";
import type { OverviewCallbacks } from "../../features/overview/callbacks.ts";
import { pathOfItem, type ItemRef } from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useInboxReveal } from "../../stores/inbox-reveal.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { LazyPane } from "./LazyPane.tsx";
import { go } from "./tab-actions.ts";

const loadOverview = () => import("./overview-pane-entry.tsx").then((m) => ({ default: m.OverviewPane }));

/**
 * The callbacks that need no hook: a card's way out is a command, a store or a URL (features never import each other).
 * The card actions are not here: `overview-pane-entry.tsx` adds them inside the lazy chunk.
 */
export const OVERVIEW_CALLBACKS: Pick<OverviewCallbacks, "revealInbox" | "newAgent" | "newProject"> = {
  revealInbox: (itemId) => {
    useInboxReveal.getState().ask(itemId);
    if (!runCommand("mobile.inbox.open")) runCommand("drawer.inbox.open");
  },
  newAgent: () => void runCommand("agents.new"),
  newProject: () => useAddProjectRequest.getState().ask(),
};

/** The avatar the agents feature draws for one agent; null while the agents store does not know the id. */
function Avatar({ agentId, avatarStyle }: { readonly agentId: string; readonly avatarStyle: AvatarStyle }) {
  const agent = useAgents((view) => view.agents.find((one) => one.id === agentId));
  return agent === undefined ? null : <AgentAvatar agent={agent} avatarStyle={avatarStyle} />;
}

/**
 * The Overview as a pane (the tab) and as the phone's Agents section. `onNavigate` runs after a callback that leaves the
 * pane for another item: the phone goes back to its Work section.
 */
export function OverviewRoute({ onNavigate }: { readonly onNavigate?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const avatarStyle = useAppearanceStore((state) => state.account.avatarStyle);
  const open = (item: ItemRef) => {
    go(navigate, pathOfItem(item));
    onNavigate?.();
  };
  const props: Omit<OverviewCallbacks, "actions"> = {
    ...OVERVIEW_CALLBACKS,
    openAgent: (id) => open({ kind: "agent", id }),
    openProject: (id) => {
      useCurrentProject.getState().choose(id);
      open({ kind: "home" });
    },
    openSession: (id) => open({ kind: "session", id }),
    // A task opens its session; the tasks stream is open only while the board is, so an unknown task opens the board.
    openTask: (id) => {
      const task = useTasksStore.getState().view.list.find((one) => one.id === id);
      open(task?.sessionId ? { kind: "session", id: task.sessionId } : { kind: "tasks" });
    },
    openHealth: () => open({ kind: "settings", section: "health" }),
    renderAvatar: (agentId) => <Avatar agentId={agentId} avatarStyle={avatarStyle} />,
  };
  return (
    <LazyPane
      load={loadOverview}
      props={props}
      fallback={<LoadingLine label={t("app.loading")} deferred={false} />}
    />
  );
}
