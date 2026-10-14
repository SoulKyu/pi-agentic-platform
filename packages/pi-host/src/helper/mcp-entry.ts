import { MCP_LIMITS, type McpServerView } from "@pap/contracts";
import { z } from "zod";
import { MASK, commandWords, joinWords, maskArgs, maskUrl, tokenLike } from "./mask.ts";

/**
 * A server name as Pi's tool names can carry it (letters, digits, `_`, `-`) and starting with a letter or a digit, so
 * `__proto__`, `constructor`, dotted and empty names are refused here (M7R87). Pi itself allows a leading `_` or `-`:
 * such an entry shows `invalid` in the overview (a stated cost) and Test refuses it too (`bad_request`).
 */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Names that would be properties of every object: refused whatever the regular expression says (M7R87). */
export const RESERVED_NAMES = new Set(["constructor", "prototype", "__proto__"]);
const OVERRIDE_KEYS = new Set(["enabled", "exposure", "toolExposure"]);
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;

const Exposure = z.enum(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);
const resolveExposure = (value: z.infer<typeof Exposure>): McpServerView["exposure"] =>
  value === "codemode-deferred" ? "codemode" : value;
const Strings = z.record(z.string(), z.string());

/**
 * The entry as the SDK documents it (`McpServerConfig`, M7R87): known fields typed, unknown fields kept. The
 * transport rules (a command or a URL, an override, the project file's limits) are in `maskMcpEntry`.
 */
export const McpEntry = z.looseObject({
  type: z.enum(["stdio", "http", "streamable-http"]).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: Strings.optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: Strings.optional(),
  oauth: z.looseObject({ clientSecret: z.string().optional() }).optional(),
  auth: z.looseObject({ provider: z.string().min(1) }).optional(),
  exposure: Exposure.optional(),
  toolExposure: z.record(z.string(), Exposure).optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
  timeout: z.number().positive().optional(),
});
export type McpEntry = z.infer<typeof McpEntry>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A name list for display: a name that is itself a long token (a value in the wrong place) is hidden, the rest clipped. */
function shownName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || tokenLike(trimmed)) return MASK;
  return trimmed.slice(0, MCP_LIMITS.nameLength);
}
const shownNames = (names: readonly string[]): string[] =>
  names.slice(0, MCP_LIMITS.names).map((name) => shownName(name));

function variablesIn(values: readonly string[]): string[] {
  const found = new Set<string>();
  for (const value of values) {
    // A value that is a command is run by a shell, not substituted: its words are not references.
    if (value.startsWith("!")) continue;
    for (const match of value.matchAll(VARIABLE)) {
      const name = match[1] ?? match[2] ?? "";
      if (name.length <= MCP_LIMITS.nameLength) found.add(name);
    }
  }
  return [...found].slice(0, MCP_LIMITS.names);
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function viewOf(
  name: string,
  scope: McpServerView["scope"],
  rest: Partial<McpServerView> & Pick<McpServerView, "kind">,
): McpServerView {
  return {
    // A name that passes SERVER_NAME is a key and a tool namespace, never masked: rows and overrides match on it.
    name: SERVER_NAME.test(name)
      ? name
      : name === ""
        ? "(empty)"
        : tokenLike(name)
          ? MASK
          : name.slice(0, MCP_LIMITS.nameLength),
    scope,
    enabled: true,
    exposure: "codemode",
    target: "",
    envNames: [],
    headerNames: [],
    commandFields: [],
    variables: [],
    oauth: false,
    toolExposureCount: 0,
    state: "on",
    lastTest: null,
    problem: null,
    ...rest,
  };
}
const invalid = (name: string, scope: McpServerView["scope"], problem: string): McpServerView =>
  viewOf(name, scope, { kind: "invalid", state: "invalid", problem });

/**
 * One `mcpServers` entry as the browser may see it (M7R83): names only for `env` and `headers`, the command line, the
 * arguments and the URL masked word by word, `!command` values reported by field name, never a literal value. A bad
 * entry gets one fixed phrase and nothing of its content.
 */
export function maskMcpEntry(name: string, raw: unknown, scope: McpServerView["scope"]): McpServerView {
  if (!SERVER_NAME.test(name) || RESERVED_NAMES.has(name)) return invalid(name, scope, "invalid-name");
  if (!isRecord(raw)) return invalid(name, scope, "invalid-shape");
  if (raw.command === undefined && raw.url === undefined && raw.type === undefined) {
    // The SDK's rule: a project entry with none of command, url and type only overrides three fields of a global one.
    if (scope !== "project") return invalid(name, scope, "no-transport");
    if (Object.keys(raw).some((key) => !OVERRIDE_KEYS.has(key)))
      return invalid(name, scope, "override-fields");
    const override = McpEntry.safeParse(raw);
    if (!override.success) return invalid(name, scope, "invalid-shape");
    const { enabled, exposure, toolExposure } = override.data;
    return viewOf(name, scope, {
      kind: "override",
      enabled: enabled !== false,
      exposure: resolveExposure(exposure ?? "codemode"),
      toolExposureCount: Object.keys(toolExposure ?? {}).length,
      state: enabled === false ? "disabled" : "on",
    });
  }
  if (raw.type === "sse") return invalid(name, scope, "sse-unsupported");
  const parsed = McpEntry.safeParse(raw);
  if (!parsed.success) return invalid(name, scope, "invalid-shape");
  const entry = parsed.data;
  const http = entry.url !== undefined && (entry.type === undefined || entry.type !== "stdio");
  const common = {
    enabled: entry.enabled !== false,
    state: entry.enabled === false ? ("disabled" as const) : ("on" as const),
    exposure: resolveExposure(entry.exposure ?? "codemode"),
    toolExposureCount: Object.keys(entry.toolExposure ?? {}).length,
  };
  if (http) {
    const url = entry.url ?? "";
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))
      return invalid(name, scope, "bad-url");
    if (entry.auth !== undefined && scope === "project") return invalid(name, scope, "auth-in-project");
    const headers = entry.headers ?? {};
    const secret = entry.oauth?.clientSecret;
    const commands = [
      ...Object.entries(headers)
        .filter(([, value]) => value.startsWith("!"))
        .map(([key]) => `headers.${shownName(key)}`),
      ...(secret?.startsWith("!") === true ? ["oauth.clientSecret"] : []),
    ];
    return viewOf(name, scope, {
      ...common,
      kind: "http",
      target: clip(maskUrl(url), MCP_LIMITS.target),
      headerNames: shownNames(Object.keys(headers)),
      commandFields: commands.slice(0, MCP_LIMITS.names),
      variables: variablesIn([url, ...Object.values(headers), ...(secret === undefined ? [] : [secret])]),
      // Pi signs in with OAuth when nothing else carries the credential: no Authorization header and no provider token.
      oauth:
        entry.auth === undefined &&
        !Object.keys(headers).some((key) => key.trim().toLowerCase() === "authorization"),
    });
  }
  if (entry.command === undefined || entry.type === "http" || entry.type === "streamable-http")
    return invalid(name, scope, "no-transport");
  const env = entry.env ?? {};
  const args = entry.args ?? [];
  // Pi runs `command` as one executable, but a whole shell line written there is read and masked as one.
  const words = commandWords(entry.command);
  return viewOf(name, scope, {
    ...common,
    kind: "stdio",
    target: clip(joinWords(maskArgs([...words, ...args])), MCP_LIMITS.target),
    ...(entry.cwd === undefined ? {} : { cwd: clip(entry.cwd, 1024) }),
    envNames: shownNames(Object.keys(env)),
    commandFields: Object.entries(env)
      .filter(([, value]) => value.startsWith("!"))
      .map(([key]) => `env.${shownName(key)}`)
      .slice(0, MCP_LIMITS.names),
    variables: variablesIn([
      entry.command,
      ...args,
      ...Object.values(env),
      ...(entry.cwd === undefined ? [] : [entry.cwd]),
    ]),
  });
}

/** Bounds for an entry pap ADDS (MC44); reading keeps the SDK's schema, so an entry Pi runs is never shown `invalid`. */
export const ENTRY_BOUNDS = {
  command: 4096,
  url: 4096,
  args: 256,
  arg: 8192,
  pairs: 128,
  key: 256,
  value: 65_536,
} as const;
export function withinAddBounds(entry: McpEntry): boolean {
  const pairsOk = (record: Record<string, string> | undefined): boolean =>
    record === undefined ||
    (Object.keys(record).length <= ENTRY_BOUNDS.pairs &&
      Object.entries(record).every(
        ([k, v]) => k.length <= ENTRY_BOUNDS.key && v.length <= ENTRY_BOUNDS.value,
      ));
  return (
    (entry.command?.length ?? 0) <= ENTRY_BOUNDS.command &&
    (entry.url?.length ?? 0) <= ENTRY_BOUNDS.url &&
    (entry.args?.length ?? 0) <= ENTRY_BOUNDS.args &&
    (entry.args ?? []).every((arg) => arg.length <= ENTRY_BOUNDS.arg) &&
    pairsOk(entry.env) &&
    pairsOk(entry.headers)
  );
}
