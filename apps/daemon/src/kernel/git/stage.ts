/**
 * The one way a lane stages files (MC1 I3): `add --pathspec-from-file=- --pathspec-file-nul` with the paths on stdin,
 * NUL separated, and every pathspec literal (`--literal-pathspecs`, which the runner puts on every `add`). Never
 * `add -A -- .` or `add -u -- .`: they walk into a nested repository and run its own clean filter. The caller takes
 * the paths from the guarded status (`--ignore-submodules=dirty`), deletions included, and leaves gitlinks out.
 */
export const MAX_STAGE_PATHS = 4096;
export const MAX_STAGE_BYTES = 512 * 1024;

/** True for a non-empty list of non-empty NUL-terminated entries within both caps. */
export function stageInputAllowed(input: Buffer | undefined): boolean {
  if (input === undefined || input.length === 0 || input.length > MAX_STAGE_BYTES) return false;
  if (input[input.length - 1] !== 0) return false;
  let paths = 0;
  let previous = 0;
  for (let at = 0; at < input.length; at += 1) {
    if (input[at] !== 0) continue;
    if (at === previous) return false;
    paths += 1;
    if (paths > MAX_STAGE_PATHS) return false;
    previous = at + 1;
  }
  return true;
}

/** The stdin for `stageInput`'s call, or null when the list is empty, too long, or holds an empty or NUL-bearing path. */
export function stageInput(paths: readonly string[]): Buffer | null {
  if (paths.some((path) => path === "" || path.includes("\0"))) return null;
  const input = Buffer.from(paths.map((path) => `${path}\0`).join(""), "utf8");
  return stageInputAllowed(input) ? input : null;
}
