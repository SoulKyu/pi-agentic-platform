export interface SecretSet {
  /** `restorable: false`: a marker for this secret is never turned back into the value (a provider credential). */
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly restorable?: boolean;
  }>;
}
export interface Redactor {
  text(text: string): { text: string; count: number; steps: number };
  /** Like `text`, but a secret is found whatever its case: for short texts the policy wrote itself (audit reasons). */
  textFolded(text: string): { text: string; count: number; steps: number };
  /**
   * Replaces every secret in the strings and the keys of a value, drops function values (a `toJSON` would bring a
   * secret back) and gives keys that collide after redaction a `~n` suffix. `text` runs on each string value after the
   * exact pass, with the name of the field that holds it (an array item has its array's) and the string as it was.
   */
  deep(
    value: unknown,
    options?: {
      readonly tooDeep?: "throw" | "replace";
      readonly text?: (text: string, field: string | undefined, original: string) => string;
    },
  ): { value: unknown; count: number };
  values(): ReadonlyMap<string, string>;
  /** The secrets a marker may be restored for: the environment's, not a provider credential. */
  restorable(): ReadonlyMap<string, string>;
  readonly entries: SecretSet["entries"];
  readonly size: number;
}
interface Candidate {
  readonly name: string;
  readonly value: string;
}
type Buckets = ReadonlyMap<string, Candidate[]>;
interface Index {
  readonly buckets: Buckets;
  readonly firstUnits: ReadonlySet<number>;
}
const MAX_DEPTH = 32;
/** `collectSecrets` keeps values of 8 characters or more: their first 8 index them. */
const HEAD = 8;
export const TOO_DEEP_TEXT = "[pap-policy: too deep to check]";

/** The value as it reads inside a JSON string: the canonical audit arguments and JSON tool output carry that form. */
const jsonEscaped = (value: string): string => JSON.stringify(value).slice(1, -1);

function indexOf(candidates: readonly Candidate[]): Index {
  // Longest first inside each bucket: a secret that contains another wins.
  // ponytail: a position costs one lookup plus the secrets sharing its head (a handful); Aho-Corasick if a vault brings thousands.
  const buckets = new Map<string, Candidate[]>();
  const firstUnits = new Set<number>();
  for (const entry of [...candidates].sort((a, b) => b.value.length - a.value.length)) {
    if (entry.value.length < HEAD) continue;
    const head = entry.value.slice(0, HEAD);
    const bucket = buckets.get(head);
    if (bucket) bucket.push(entry);
    else buckets.set(head, [entry]);
    firstUnits.add(entry.value.charCodeAt(0));
  }
  return { buckets, firstUnits };
}

function scan(index: Index, input: string, haystack: string) {
  if (index.buckets.size === 0) return { text: input, count: 0, steps: 0 };
  let out = "";
  let count = 0;
  let steps = 0;
  let from = 0;
  for (let i = 0; i + HEAD <= haystack.length;) {
    if (!index.firstUnits.has(haystack.charCodeAt(i))) {
      i++;
      continue;
    }
    let hit: Candidate | undefined;
    for (const entry of index.buckets.get(haystack.slice(i, i + HEAD)) ?? []) {
      steps++;
      if (haystack.startsWith(entry.value, i)) {
        hit = entry;
        break;
      }
    }
    if (hit) {
      out += `${input.slice(from, i)}[SECRET:${hit.name}]`;
      i += hit.value.length;
      from = i;
      count++;
    } else i++;
  }
  return count === 0 ? { text: input, count: 0, steps } : { text: out + input.slice(from), count, steps };
}

export function createRedactor(set: SecretSet): Redactor {
  const candidates: Candidate[] = [];
  for (const entry of set.entries) {
    candidates.push(entry);
    const escaped = jsonEscaped(entry.value);
    if (escaped !== entry.value) candidates.push({ name: entry.name, value: escaped });
  }
  const exact = indexOf(candidates);
  let folded: Index | undefined;
  const text = (input: string) => scan(exact, input, input);
  const textFolded = (input: string) => {
    folded ??= indexOf(candidates.map(({ name, value }) => ({ name, value: value.toLowerCase() })));
    const lower = input.toLowerCase();
    // Lower-casing can change the length (U+0130): positions would shift, so that text is judged, and returned, in lower case.
    return lower.length === input.length ? scan(folded, input, lower) : scan(folded, lower, lower);
  };
  const byName = new Map(set.entries.map((entry) => [entry.name, entry.value]));
  const restorable = new Map(
    set.entries.filter((entry) => entry.restorable !== false).map((entry) => [entry.name, entry.value]),
  );
  const deep = (
    value: unknown,
    tooDeep: "throw" | "replace",
    after: (text: string, field: string | undefined, original: string) => string,
    field: string | undefined,
    depth: number,
  ): { value: unknown; count: number } => {
    if (typeof value === "string") {
      const done = text(value);
      return { value: after(done.text, field, value), count: done.count };
    }
    if (typeof value === "function") return { value: null, count: 0 };
    if (value === null || typeof value !== "object") return { value, count: 0 };
    if (depth >= MAX_DEPTH) {
      if (tooDeep === "throw") throw new RangeError("value too deep to redact");
      return { value: TOO_DEEP_TEXT, count: 0 };
    }
    let count = 0;
    const walk = (item: unknown, key = field) => {
      const done = deep(item, tooDeep, after, key, depth + 1);
      count += done.count;
      return done.value;
    };
    if (Array.isArray(value)) {
      const items = value.map((item) => walk(item));
      return { value: items, count };
    }
    const copy: Record<string, unknown> = {};
    // defineProperty: an own key named `__proto__` must stay a key, not replace the prototype of the copy.
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "function") continue;
      const named = text(key);
      count += named.count;
      const base = named.text;
      let name = base;
      for (let n = 2; Object.hasOwn(copy, name); n++) name = `${base}~${n}`;
      Object.defineProperty(copy, name, {
        value: walk(item, key),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { value: copy, count };
  };
  return {
    text,
    textFolded,
    deep: (value, options) =>
      deep(value, options?.tooDeep ?? "throw", options?.text ?? ((text) => text), undefined, 0),
    values: () => byName,
    restorable: () => restorable,
    entries: set.entries,
    size: set.entries.length,
  };
}

export const NO_REDACTOR: Redactor = createRedactor({ entries: [] });
