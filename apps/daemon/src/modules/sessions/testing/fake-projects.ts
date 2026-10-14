import { basename } from "node:path";
import type { ProjectsPort, ProjectView } from "../../projects/index.ts";

export interface FakeProjectsPort extends ProjectsPort {
  /** Every `ensure` call, in order. */
  readonly ensured: Array<{ ownerId: string; root: string }>;
}

const PREFIX = "p:";

/** A projects port for sessions tests: one project per root, id `p:<root>`; refused roots answer null. */
export function fakeProjectsPort(options: { refuse?: string[] } = {}): FakeProjectsPort {
  const ensured: Array<{ ownerId: string; root: string }> = [];
  const seen = new Set<string>();
  const listeners = new Set<(ownerId: string, project: ProjectView) => void>();
  const viewOf = (root: string): ProjectView => ({
    id: `${PREFIX}${root}`,
    root,
    name: basename(root),
    position: 0,
  });
  return {
    ensured,
    ensure(ownerId, root) {
      ensured.push({ ownerId, root });
      if (options.refuse?.includes(root)) return null;
      const view = viewOf(root);
      const key = JSON.stringify([ownerId, root]);
      if (!seen.has(key)) {
        seen.add(key);
        for (const listener of [...listeners]) listener(ownerId, view);
      }
      return view;
    },
    list: (_ownerId, ids) =>
      ids.filter((id) => id.startsWith(PREFIX)).map((id) => viewOf(id.slice(PREFIX.length))),
    roots: (ownerId) =>
      [
        ...new Set(
          ensured
            .filter((call) => call.ownerId === ownerId && !options.refuse?.includes(call.root))
            .map((call) => call.root),
        ),
      ].reverse(),
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
