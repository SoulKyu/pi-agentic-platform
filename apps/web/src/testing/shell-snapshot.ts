import type { ProjectSummary, ShellSession } from "@pap/contracts";

export const shellSession = (patch: Partial<ShellSession> & { id: string }): ShellSession => ({
  cwd: `/w/${patch.id}`,
  name: null,
  preview: null,
  status: "cold",
  needsInput: false,
  projectId: null,
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

export const shellProject = (patch: Partial<ProjectSummary> & { id: string }): ProjectSummary => ({
  root: `/w/${patch.id}`,
  name: patch.id,
  position: 1,
  sessions: 0,
  ...patch,
});

/** The first event of the `shell` stream. */
export const shellSnapshot = (
  sessions: ShellSession[],
  patch: { projects?: ProjectSummary[]; more?: number; moreProjects?: number; archived?: number } = {},
) => ({
  kind: "snapshot",
  projects: patch.projects ?? [],
  sessions,
  more: patch.more ?? 0,
  moreProjects: patch.moreProjects ?? 0,
  archived: patch.archived ?? 0,
});
