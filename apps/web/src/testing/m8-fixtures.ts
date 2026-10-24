import type { TerminalView, VcsFile, VcsStatus } from "@pap/contracts";

export const vcsStatus = (root: string, overrides: Partial<VcsStatus> = {}): VcsStatus => ({
  root,
  repo: true,
  branch: "main",
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  truncated: false,
  additions: 0,
  deletions: 0,
  at: 1,
  error: null,
  ...overrides,
});

export const vcsFile = (path: string, overrides: Partial<VcsFile> = {}): VcsFile => ({
  path,
  oldPath: null,
  folder: false,
  index: " ",
  worktree: "M",
  kind: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
  ...overrides,
});

export const terminalId = (n: number) => `terminal-${String(n).padStart(13, "0")}`;
export const terminalView = (n: number, overrides: Partial<TerminalView> = {}): TerminalView => ({
  id: terminalId(n),
  cwd: "/work",
  sessionId: null,
  projectId: null,
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  signal: null,
  createdAt: n,
  ...overrides,
});
