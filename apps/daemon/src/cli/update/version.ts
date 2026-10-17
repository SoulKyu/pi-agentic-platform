const VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;

interface Parsed {
  readonly core: readonly bigint[];
  readonly pre: readonly string[] | null;
}

function parse(version: string): Parsed {
  const match = VERSION_SHAPE.exec(version);
  if (match === null) throw new Error("not a version");
  return {
    core: [BigInt(match[1] as string), BigInt(match[2] as string), BigInt(match[3] as string)],
    pre: match[4] === undefined ? null : match[4].split("."),
  };
}

const NUMERIC = /^\d+$/;

function compareIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) {
    const [x, y] = [BigInt(a), BigInt(b)];
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1; // numeric identifiers sort below alphanumeric ones
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Semver order without a library (M6bR23): the numeric core first, a release beats a pre-release of the same core, then the
 * pre-release identifiers one by one (numeric ones as numbers, a shorter list below a longer one with the same start).
 * Build metadata is not accepted. Throws "not a version" for anything else.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const [x, y] = [left.core[i] as bigint, right.core[i] as bigint];
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left.pre === null || right.pre === null) {
    if (left.pre === right.pre) return 0;
    return left.pre === null ? 1 : -1;
  }
  const shared = Math.min(left.pre.length, right.pre.length);
  for (let i = 0; i < shared; i++) {
    const order = compareIdentifier(left.pre[i] as string, right.pre[i] as string);
    if (order !== 0) return order;
  }
  return left.pre.length === right.pre.length ? 0 : left.pre.length < right.pre.length ? -1 : 1;
}
