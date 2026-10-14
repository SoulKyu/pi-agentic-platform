import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoverContext, ShellFacts } from "./command-cover.ts";

/** The shared bed of the command-cover tests: a home with a clean repository, Pi's agent folder and pap's home. */

export const CLEAN = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";

export const SAFE_SHELL: ShellFacts = {
  commandPrefix: undefined,
  shellPath: undefined,
  startupFile: false,
  cdPath: false,
  gitEnv: false,
  rgConfig: false,
  path: "/usr/local/bin:/usr/bin:/bin",
};

export function handRepo(top: string, config: string): void {
  const git = join(top, ".git");
  mkdirSync(join(git, "objects"), { recursive: true });
  mkdirSync(join(git, "refs"), { recursive: true });
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(git, "config"), config);
}

export function makeBed() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pap-cover-")));
  const cwd = join(base, "proj");
  const agentDir = join(base, "agent");
  const papHome = join(base, "pap");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "bin"));
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  mkdirSync(join(papHome, "secrets"), { recursive: true });
  handRepo(cwd, CLEAN);
  mkdirSync(join(cwd, "vendor", "dirty"), { recursive: true });
  handRepo(join(cwd, "vendor", "dirty"), `${CLEAN}[core]\n\tfsmonitor = ./hook.sh\n`);
  mkdirSync(join(cwd, "vendor", "dirty", "sub"));
  symlinkSync(join(cwd, "vendor", "dirty", "sub"), join(cwd, "lnk"));
  for (const name of ["README.md", "a.txt", "b.txt", join("src", "a.ts")])
    writeFileSync(join(cwd, name), "x\n");
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "sessions", "x.jsonl"), "{}");
  writeFileSync(join(papHome, "state.db"), "x");
  writeFileSync(join(papHome, "secrets", "k"), "x");
  symlinkSync(join(cwd, "bin"), join(base, "linkbin"));
  const ctx = (
    over: Partial<Omit<CoverContext, "shell">> & { shell?: Partial<ShellFacts> } = {},
  ): CoverContext => ({
    cwd,
    home: base,
    papHome,
    agentDir,
    readOnly: true,
    tainted: false,
    ...over,
    shell: { ...SAFE_SHELL, ...over.shell },
  });
  return { base, cwd, agentDir, papHome, ctx };
}
