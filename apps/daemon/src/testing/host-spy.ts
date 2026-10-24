/**
 * What a journey records of the daemon's own file system helpers (the kernel's `safe-open` and `boundary.judgePath`, the git
 * runner, `realpath`): every call with the path it was given. A box project is not on this machine, so a test asserts that no
 * call names a path at or under the project's root (the process backend makes that root a real host folder, which is what
 * makes the check meaningful). Used through `vi.mock` factories, which cannot close over module scope.
 */
export const hostCalls: Array<{ readonly fn: string; readonly path: string }> = [];

function pathsOf(args: readonly unknown[]): string[] {
  const found: string[] = [];
  for (const arg of args) {
    if (typeof arg === "string") found.push(arg);
    else if (arg instanceof URL) found.push(arg.pathname);
    else if (typeof arg === "object" && arg !== null) {
      for (const key of ["path", "real", "root", "cwd", "target"]) {
        const value = (arg as Record<string, unknown>)[key];
        if (typeof value === "string") found.push(value);
      }
    }
  }
  return found;
}

/** The function, recording its string and object-path arguments under `name`. */
export function recorded<F extends (...args: never[]) => unknown>(name: string, fn: F): F {
  const wrapped = (...args: unknown[]): unknown => {
    for (const path of pathsOf(args)) hostCalls.push({ fn: name, path });
    return (fn as unknown as (...a: unknown[]) => unknown)(...args);
  };
  return Object.assign(wrapped, fn) as unknown as F;
}

/** The calls whose path is `root` or below it, as `fn path` lines. */
export const callsUnder = (root: string): string[] =>
  hostCalls
    .filter(({ path }) => path === root || path.startsWith(`${root}/`))
    .map(({ fn, path }) => `${fn} ${path}`);
