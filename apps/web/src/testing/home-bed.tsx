import { DEFAULT_HOME_LAYOUT, type ToolPreset } from "@pap/contracts";
import { ProjectHome } from "../features/home/ProjectHome.tsx";
import { useCurrentProject } from "../stores/current-project.ts";
import { useShellStore } from "../stores/shell-store.ts";
import { useTasksStore } from "../stores/tasks-store.ts";
import { mount, settle } from "./dom.ts";
import { fakeHomeActions, SHORTCUTS } from "./home-actions.ts";
import { shellProject, shellSnapshot } from "./shell-snapshot.ts";

export const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
export const web = shellProject({ id: "p2", name: "web", root: "/w/web", sessions: 1 });

/** Two projects in the shell store, `projectId` in the switcher (null: All projects), no tasks, nothing stored. */
export function resetHome(projectId: string | null = "p1"): void {
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [api, web] }));
  useCurrentProject.setState({ projectId, storageRefused: false, startedHere: 0 });
  useTasksStore.getState().reset();
}

export async function showHome(actions = fakeHomeActions(), preset: ToolPreset = "configured") {
  const page = await mount(
    <ProjectHome
      actions={actions}
      shortcuts={SHORTCUTS}
      preset={preset}
      layout={DEFAULT_HOME_LAYOUT}
      presetField={(disabled) => <p data-preset-field={String(disabled)}>preset field</p>}
    />,
  );
  await settle();
  return { page, actions };
}

export const composer = () => document.querySelector('textarea[name="launch"]') as HTMLTextAreaElement;
export const chip = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (node) => node.textContent === label,
  ) as HTMLElement;
