import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** A folder inside (or equal to) `root`, compared on real paths. */
function isInside(path: string, root: string): boolean {
  const from = relative(root, path);
  return from === "" || (from !== ".." && !from.startsWith("../") && !isAbsolute(from));
}
const realOrResolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** True when a real folder is, or lies inside, one of pap's or Pi's own state folders (M10R20). */
export const isStateFolder = (real: string, states: readonly string[]): boolean =>
  states.some((state) => isInside(real, realOrResolved(state)));
