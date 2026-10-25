import type { ShellView } from "./shell-reducer.ts";

/** True when `path` is a box project's root or under it (UX only: the daemon's gate is the one that refuses). */
export function isBoxPath(view: ShellView, path: string): boolean {
  for (const project of view.projects.values())
    if (project.kind === "box" && (path === project.root || path.startsWith(`${project.root}/`))) return true;
  return false;
}
