import { join } from "node:path";
import { HELPER_OPS, MCP_LIMITS, type McpRowCode } from "@pap/contracts";
import type { z } from "zod";
import {
  changed,
  entryOf,
  hasEntry,
  insertEntry,
  isRecord,
  McpFileInvalid,
  objectOf,
  parseMcpDoc,
  removeEntry,
  replaceEntry,
  serialize,
  withKey,
  type McpDoc,
} from "../mcp-file.ts";
import { McpEntry, maskMcpEntry, withinAddBounds } from "../mcp-entry.ts";
import { defineOp, type HelperContext, HelperOpError } from "../ops.ts";
import { PiFileRefused, readPiFile, writePiFile } from "../pi-file.ts";
import { isTrusted } from "./models-open.ts";

type Ctx = Pick<HelperContext, "agentDir" | "home" | "cwd">;
type Scope = "global" | "project";
type Params<N extends keyof typeof HELPER_OPS> = z.infer<(typeof HELPER_OPS)[N]["params"]>;
/** What an undo record may weigh: the entry text travels in a helper record and sits in the daemon's memory. */
const ENTRY_TEXT_MAX = 262_144;

interface Loaded {
  readonly path: string;
  readonly roots: readonly string[];
  readonly scope: Scope;
  readonly doc: McpDoc;
}

/** Names that differ only by `-` and `_` share a namespace in Pi's tool names. */
const namespace = (name: string): string => name.replaceAll("-", "_");

/**
 * A project target is written only with the "Save anyway?" confirmation (a protected file, M7R133) and a trust decision
 * `true` (M7R89). The daemon asks for the confirmation too; this is the second lock, so a helper run never depends on it.
 */
async function guard(scope: Scope, ctx: Ctx, confirmProtected: boolean | undefined): Promise<void> {
  if (scope === "global") return;
  if (ctx.cwd === undefined) throw new HelperOpError("bad_params", "cwd");
  if (confirmProtected !== true) throw new HelperOpError("protected_path");
  if (!isTrusted(ctx.agentDir, ctx.cwd)) throw new HelperOpError("project_untrusted");
}

const fileError = (error: unknown): never => {
  if (error instanceof PiFileRefused)
    throw new HelperOpError(
      error.reason === "hard-link" ? "config_hard_link" : "config_path_refused",
      error.reason,
    );
  if (error instanceof McpFileInvalid) throw new HelperOpError("config_invalid", "mcp.json");
  throw error;
};

const placeOf = (scope: Scope, ctx: Ctx) =>
  scope === "global"
    ? { path: join(ctx.agentDir, "mcp.json"), roots: [ctx.agentDir, ctx.home] }
    : { path: join(ctx.cwd ?? "", ".pi", "mcp.json"), roots: [ctx.cwd ?? ""] };

async function load(scope: Scope, ctx: Ctx): Promise<Loaded> {
  const place = placeOf(scope, ctx);
  try {
    return { ...place, scope, doc: parseMcpDoc((await readPiFile(place.path, place.roots)).text) };
  } catch (error) {
    return fileError(error);
  }
}

/** The global file may hold literal secrets: always 0600. The project file keeps its mode (0644 when new, M7R89). */
async function save(file: Loaded, doc: McpDoc): Promise<void> {
  if (!changed(doc)) return;
  try {
    await writePiFile(file.path, serialize(doc), {
      roots: file.roots,
      mode: file.scope === "global" ? 0o600 : 0o644,
      keepMode: file.scope === "project",
    });
  } catch (error) {
    fileError(error);
  }
}

type Checked = { readonly entry: Record<string, unknown>; readonly override: boolean } | McpRowCode;

/** An existing entry that can be edited: a record that Pi's entry rules (and this module's limits) accept. */
function check(doc: McpDoc, scope: Scope, name: string): Checked {
  if (!hasEntry(doc, name)) return "not_found";
  const raw = entryOf(doc, name);
  const view = maskMcpEntry(name, raw, scope);
  if (view.kind === "invalid") return view.problem === "invalid-name" ? "invalid_name" : "invalid_entry";
  return { entry: raw as Record<string, unknown>, override: view.kind === "override" };
}

const enabledValue = (enabled: boolean, override: boolean): boolean | undefined =>
  override || !enabled ? enabled : undefined;
/** `codemode` is the default, so it deletes its key, except in a project override where it replaces the global value. */
const exposureValue = (exposure: string, override: boolean): string | undefined =>
  exposure === "codemode" && !override ? undefined : exposure;

export async function setEnabled(params: Params<"mcp.setEnabled">, ctx: Ctx) {
  const scopes = [...new Set(params.servers.map((row) => row.scope))];
  for (const scope of scopes) await guard(scope, ctx, params.confirmProtected);
  const files = new Map<Scope, Loaded>();
  for (const scope of scopes) files.set(scope, await load(scope, ctx));
  const results: Array<{ scope: Scope; name: string; ok: boolean; code?: McpRowCode }> = [];
  for (const { scope, name } of params.servers) {
    const file = files.get(scope) as Loaded;
    const found = check(file.doc, scope, name);
    if (typeof found === "string") {
      results.push({ scope, name, ok: false, code: found });
      continue;
    }
    const next = withKey(found.entry, "enabled", enabledValue(params.enabled, found.override));
    files.set(scope, { ...file, doc: replaceEntry(file.doc, name, next) });
    results.push({ scope, name, ok: true });
  }
  // A failed save marks only that file's rows; rows of a file already written stay ok (MC44 M1).
  for (const file of files.values())
    try {
      await save(file, file.doc);
    } catch {
      for (const row of results)
        if (row.scope === file.scope && row.ok) Object.assign(row, { ok: false, code: "write_failed" });
    }
  return { results };
}

export async function setExposure(params: Params<"mcp.setExposure">, ctx: Ctx) {
  await guard(params.scope, ctx, params.confirmProtected);
  const file = await load(params.scope, ctx);
  const found = check(file.doc, params.scope, params.name);
  if (typeof found === "string")
    throw new HelperOpError(found === "not_found" ? "not_found" : "bad_params", found);
  const next = withKey(found.entry, "exposure", exposureValue(params.exposure, found.override));
  await save(file, replaceEntry(file.doc, params.name, next));
  return { ok: true as const };
}

/** The project's own switch for a global server: an override entry `{ enabled }` in the project file (M7R88). */
export async function setInProject(params: Params<"mcp.setInProject">, ctx: Ctx) {
  await guard("project", ctx, params.confirmProtected);
  const base = check((await load("global", ctx)).doc, "global", params.name);
  if (typeof base === "string")
    throw new HelperOpError(base === "not_found" ? "not_found" : "bad_params", base);
  const file = await load("project", ctx);
  const found = check(file.doc, "project", params.name);
  if (found === "not_found") {
    // Without an override a server is on; only a globally disabled one needs `{ enabled: true }` to be switched on here.
    const needed = !params.enabled || base.entry.enabled === false;
    if (needed) await save(file, insertEntry(file.doc, params.name, { enabled: params.enabled }));
  } else if (typeof found === "string") throw new HelperOpError("bad_params", found);
  else {
    const next = withKey(found.entry, "enabled", enabledValue(params.enabled, found.override));
    await save(file, replaceEntry(file.doc, params.name, next));
  }
  return { ok: true as const };
}

/** Removes any own entry, an invalid one included (clean-up); answers the entry text for the daemon's undo record. */
export async function removeServer(params: Params<"mcp.remove">, ctx: Ctx) {
  await guard(params.scope, ctx, params.confirmProtected);
  const file = await load(params.scope, ctx);
  if (!hasEntry(file.doc, params.name)) throw new HelperOpError("not_found", "entry");
  const { doc, index, entry } = removeEntry(file.doc, params.name);
  const text = JSON.stringify(entry);
  if (text.length > ENTRY_TEXT_MAX) throw new HelperOpError("bad_params", "entry-too-big");
  await save(file, doc);
  return { index, entry: text };
}

export async function restoreServer(params: Params<"mcp.restore">, ctx: Ctx) {
  await guard(params.scope, ctx, params.confirmProtected);
  let entry: unknown;
  try {
    entry = JSON.parse(params.entry);
  } catch {
    throw new HelperOpError("bad_params", "entry");
  }
  if (!isRecord(entry)) throw new HelperOpError("bad_params", "entry");
  const file = await load(params.scope, ctx);
  const names = Object.keys(file.doc.servers);
  if (names.some((name) => namespace(name) === namespace(params.name)))
    throw new HelperOpError("conflict", "name");
  if (names.length >= MCP_LIMITS.servers) throw new HelperOpError("bad_params", "full");
  await save(file, insertEntry(file.doc, params.name, entry, params.index));
  return { ok: true as const };
}

/**
 * Adds an entry the browser parsed (M7R91): valid by `McpEntry` and the transport rules, a new name in the file's namespace,
 * and no `auth.provider` in a project file. Nothing of the entry is logged or returned.
 */
export async function addServer(params: Params<"mcp.add">, ctx: Ctx) {
  await guard(params.scope, ctx, params.confirmProtected);
  const entry = objectOf(Object.entries(params.entry));
  if (JSON.stringify(entry).length > ENTRY_TEXT_MAX) throw new HelperOpError("bad_params", "entry-too-big");
  if (maskMcpEntry(params.name, entry, params.scope).kind === "invalid")
    throw new HelperOpError("bad_params", "entry");
  const bounded = McpEntry.safeParse(entry);
  if (!bounded.success || !withinAddBounds(bounded.data))
    throw new HelperOpError("bad_params", "entry-bounds");
  if (params.scope === "project" && "auth" in entry) throw new HelperOpError("bad_params", "auth-in-project");
  const file = await load(params.scope, ctx);
  const names = Object.keys(file.doc.servers);
  if (names.some((name) => namespace(name) === namespace(params.name)))
    throw new HelperOpError("conflict", "name");
  if (names.length >= MCP_LIMITS.servers) throw new HelperOpError("bad_params", "full");
  await save(file, insertEntry(file.doc, params.name, entry));
  return { ok: true as const };
}

export const mcpSetEnabledOp = defineOp({
  params: HELPER_OPS["mcp.setEnabled"].params,
  run: (params, ctx) => setEnabled(params, ctx),
});
export const mcpSetExposureOp = defineOp({
  params: HELPER_OPS["mcp.setExposure"].params,
  run: (params, ctx) => setExposure(params, ctx),
});
export const mcpSetInProjectOp = defineOp({
  params: HELPER_OPS["mcp.setInProject"].params,
  run: (params, ctx) => setInProject(params, ctx),
});
export const mcpRemoveOp = defineOp({
  params: HELPER_OPS["mcp.remove"].params,
  run: (params, ctx) => removeServer(params, ctx),
});
export const mcpRestoreOp = defineOp({
  params: HELPER_OPS["mcp.restore"].params,
  run: (params, ctx) => restoreServer(params, ctx),
});
export const mcpAddOp = defineOp({
  params: HELPER_OPS["mcp.add"].params,
  run: (params, ctx) => addServer(params, ctx),
});
