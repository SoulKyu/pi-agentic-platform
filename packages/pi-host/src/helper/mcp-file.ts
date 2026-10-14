import { MCP_LIMITS } from "@pap/contracts";

/** The file is not a JSON object with an object `mcpServers` (or has more servers than the overview lists). */
export class McpFileInvalid extends Error {
  constructor() {
    super("mcp.json is not editable");
    this.name = "McpFileInvalid";
  }
}

export interface McpDoc {
  readonly root: Record<string, unknown>;
  readonly servers: Record<string, unknown>;
  /** The file's first indentation (default two spaces). */
  readonly indent: string;
  /** The compact text of `root` as read: an edit that leaves it equal writes nothing. */
  readonly snapshot: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Own keys only, written with `defineProperty` (M7R88): a key named `__proto__` is data here, never the prototype setter.
 * Every edit rebuilds the object through this, so such a key survives edits to other entries.
 */
export function objectOf(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries)
    Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
  return out;
}

const INDENT = /\n([ \t]+)\S/;
const indentOf = (text: string): string => INDENT.exec(text)?.[1]?.slice(0, 10) ?? "  ";

/** `null` is a file that does not exist yet: an empty document. */
export function parseMcpDoc(text: string | null): McpDoc {
  if (text === null) return { root: {}, servers: {}, indent: "  ", snapshot: "{}" };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new McpFileInvalid();
  }
  if (!isRecord(root)) throw new McpFileInvalid();
  const servers = Object.hasOwn(root, "mcpServers") ? root.mcpServers : {};
  if (!isRecord(servers) || Object.keys(servers).length > MCP_LIMITS.servers) throw new McpFileInvalid();
  return { root, servers, indent: indentOf(text), snapshot: JSON.stringify(root) };
}

/** A name read with `Object.hasOwn`: `servers["__proto__"]` would otherwise answer `Object.prototype`. */
export const entryOf = (doc: McpDoc, name: string): unknown =>
  Object.hasOwn(doc.servers, name) ? doc.servers[name] : undefined;
export const hasEntry = (doc: McpDoc, name: string): boolean => Object.hasOwn(doc.servers, name);

const withServers = (doc: McpDoc, entries: ReadonlyArray<readonly [string, unknown]>): McpDoc => {
  const servers = objectOf(entries);
  const rootEntries = Object.entries(doc.root);
  const has = rootEntries.some(([key]) => key === "mcpServers");
  const root = objectOf(
    has
      ? rootEntries.map(([key, value]) => [key, key === "mcpServers" ? servers : value] as const)
      : [...rootEntries, ["mcpServers", servers] as const],
  );
  return { ...doc, root, servers };
};

export const replaceEntry = (doc: McpDoc, name: string, value: unknown): McpDoc =>
  withServers(
    doc,
    Object.entries(doc.servers).map(([key, old]) => [key, key === name ? value : old] as const),
  );

export function insertEntry(doc: McpDoc, name: string, value: unknown, index?: number): McpDoc {
  const entries = Object.entries(doc.servers);
  entries.splice(index === undefined ? entries.length : Math.min(index, entries.length), 0, [name, value]);
  return withServers(doc, entries);
}

export function removeEntry(doc: McpDoc, name: string): { doc: McpDoc; index: number; entry: unknown } {
  const entries = Object.entries(doc.servers);
  const index = entries.findIndex(([key]) => key === name);
  const entry = entries[index]?.[1];
  entries.splice(index, 1);
  return { doc: withServers(doc, entries), index, entry };
}

/** One key of an entry set (`undefined` deletes it); a new key goes last, an existing one keeps its place. */
export function withKey(
  entry: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const entries = Object.entries(entry);
  if (!entries.some(([name]) => name === key))
    return value === undefined ? entry : objectOf([...entries, [key, value]]);
  return objectOf(
    entries.flatMap(([name, old]) =>
      name !== key ? [[name, old] as const] : value === undefined ? [] : [[name, value] as const],
    ),
  );
}

export const changed = (doc: McpDoc): boolean => JSON.stringify(doc.root) !== doc.snapshot;
export const serialize = (doc: McpDoc): string => `${JSON.stringify(doc.root, null, doc.indent)}\n`;
