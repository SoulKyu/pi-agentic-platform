import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BoundaryConfig } from "../fs/boundary.ts";
import type { DenySources } from "../fs/deny-set.ts";

/** A temporary tree for the path judge: `home/` is the home folder, never the real `~`. */
export function createBoundaryBed() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pap-boundary-")));
  const home = join(base, "home");
  const file = (path: string, content = "x") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const folder = (path: string) => mkdirSync(path, { recursive: true });
  const link = (target: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
  };
  const papHome = join(home, ".pap");
  const agentDir = join(home, ".pi", "agent");
  const proj = join(home, "proj");
  const outside = join(base, "outside");
  file(join(papHome, "state.db"));
  folder(join(papHome, "worktrees", "x"));
  for (const name of ["auth", "models", "mcp", "trust", "settings"]) file(join(agentDir, `${name}.json`));
  file(join(agentDir, "sessions", "x", "a.jsonl"));
  file(join(agentDir, "extensions", "e.ts"));
  file(join(proj, "a.txt"));
  file(join(proj, "src", "a.ts"));
  file(join(proj, ".git", "config"));
  folder(join(proj, ".git", "hooks"));
  file(join(proj, ".envrc"));
  file(join(proj, ".pi", "mcp.json"));
  file(join(proj, ".pi", "settings.json"));
  file(join(proj, ".mcp.json"));
  file(join(home, ".bashrc"));
  file(join(home, ".ssh", "id"));
  file(join(outside, "secret.txt"));
  file(join(base, "run-user", "bus"));
  folder(join(outside, "deep"));
  const config = (over: Partial<BoundaryConfig> = {}): BoundaryConfig => ({
    papHome: [papHome],
    agentDir: [agentDir],
    home: [home],
    papHomeOpen: [],
    runtimeDirs: [join(base, "run-user")],
    ...over,
  });
  /** What a daemon feeds the deny set: the named private entries (M8R103) and, whole, `$PAP_HOME` (MC8, MC11). */
  const denySources = (skip: readonly string[] = []): DenySources => ({
    files: [
      ...["auth", "models", "mcp", "trust", "settings"].map((name) => join(agentDir, `${name}.json`)),
      ...["state.db", "state.db-wal", "state.db-shm", "pap.lock"].map((name) => join(papHome, name)),
    ],
    folders: [
      join(agentDir, "sessions"),
      ...["secrets", "backups", "exports", "fork-tmp"].map((name) => join(papHome, name)),
      papHome,
    ],
    skip,
  });
  return {
    base,
    denySources,
    home,
    papHome,
    agentDir,
    proj,
    outside,
    file,
    folder,
    link,
    config,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}
