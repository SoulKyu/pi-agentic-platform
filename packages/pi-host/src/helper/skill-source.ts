import { SKILLS_CLI } from "@pap/contracts";

const OWNER_REPO =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:@[A-Za-z0-9][A-Za-z0-9._:-]{0,99})?$/;
const GITHUB =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/tree\/(?!(?:[^/]*\/)*\.{1,2}(?:\/|$))[A-Za-z0-9._/-]{1,200})?$/;

/** M7R112: an `owner/repo[@skill]` or a GitHub URL; anything else (an option, a path, a URL elsewhere) is refused. */
export function skillSource(raw: string): string | null {
  const source = raw.trim();
  return OWNER_REPO.test(source) || GITHUB.test(source) ? source : null;
}

/** The exact `npx` arguments: no shell, no other flag a source could add. */
export function skillInstallArgs(source: string, scope: "global" | "project"): string[] {
  return ["--yes", SKILLS_CLI, "add", source, "-y", "--agent", "pi", ...(scope === "global" ? ["-g"] : [])];
}
