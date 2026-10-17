/**
 * The lazy chunks of the shell, loaded by the test bed before the shell mounts.
 *
 * Under a loaded host the first `import()` of a chunk (transform, then evaluate) can outlast any fixed `waitFor`
 * budget. Awaiting the import itself, outside every poll, waits for the real condition: the module is in the
 * registry, so the shell's own `lazy()` resolves in a few ticks.
 */
const CHUNKS = {
  treeDrawer: () =>
    Promise.all([import("../routes/shell/TreeDrawer.tsx"), import("../features/projects/ProjectTree.tsx")]),
  inboxDrawer: () => import("../routes/shell/InboxDrawer.tsx"),
  menu: () => import("@pap/ui/overlays"),
  session: () => import("../features/sessions/SessionScreen.tsx"),
  settings: () => import("../routes/settings/SettingsScreen.tsx"),
  tasks: () => import("../routes/shell/tasks-pane-entry.tsx"),
  trigger: () => import("../routes/shell/trigger-pane-entry.tsx"),
  lane: () => import("../features/lanes/LaneScreen.tsx"),
  compare: () => import("../features/lanes/CompareScreen.tsx"),
  changes: () => import("../features/vcs/ChangesPane.tsx"),
  terminal: () => import("../features/terminal/TerminalPane.tsx"),
  agent: () => import("../routes/shell/agent-pane-entry.tsx"),
  agentsPhone: () => import("../routes/shell/AgentsSection.tsx"),
  newAgent: () => import("../routes/shell/new-agent-entry.tsx"),
} as const;

export type ChunkName = keyof typeof CHUNKS;

/** The chunks a route shows on first paint. */
const BY_PATH: ReadonlyArray<readonly [prefix: string, chunk: ChunkName]> = [
  ["/s/", "session"],
  ["/settings", "settings"],
  ["/tasks", "tasks"],
  ["/trigger/", "trigger"],
  ["/lane/", "lane"],
  ["/compare/", "compare"],
  ["/agents/", "agent"],
];

/** The chunks the shell opens on a gesture (a drawer): always ready. */
const ALWAYS: readonly ChunkName[] = ["treeDrawer", "inboxDrawer", "agentsPhone"];

/** Resolves when every chunk the page at `path` can show, and the extra `chunks`, have settled. */
export async function loadShellChunks(path: string, chunks: readonly ChunkName[] = []): Promise<void> {
  const wanted = new Set<ChunkName>([...ALWAYS, ...chunks]);
  for (const [prefix, chunk] of BY_PATH) if (path.startsWith(prefix)) wanted.add(chunk);
  // A chunk that fails to load (a test that mocks the failure) is the shell's to report, not the warm-up's.
  await Promise.allSettled([...wanted].map((name) => CHUNKS[name]()));
}
