import { realpathSync, statSync } from "node:fs";

/**
 * The folder a terminal may start in: the project or a folder below it, by name and by what the name resolves to (a link
 * out of the project is refused). Returns the resolved folder, or null.
 */
export function terminalCwd(project: string | undefined, cwd: string): string | null {
  if (project === undefined) return null;
  const named = cwd === project || cwd.startsWith(`${project}/`);
  if (!named || cwd.split("/").some((segment) => segment === "..")) return null;
  try {
    const root = realpathSync(project);
    const real = realpathSync(cwd);
    if (!statSync(real).isDirectory()) return null;
    return real === root || real.startsWith(`${root}/`) ? real : null;
  } catch {
    return null;
  }
}
