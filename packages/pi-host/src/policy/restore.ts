import type { CallAuditEntry } from "@pap/contracts";
import type { CallFacts, Stages } from "./pipeline.ts";

const MARKER = /\[SECRET:([A-Za-z0-9_]{1,64})\]/g;

/** Linear: the replacement is never scanned again, and a name is at most 64 characters. */
export function restoreMarkers(
  text: string,
  values: ReadonlyMap<string, string>,
): { text: string; count: number } {
  let count = 0;
  const out = text.replace(MARKER, (marker, name: string) => {
    const value = values.get(name);
    if (value === undefined) return marker;
    count++;
    return value;
  });
  return { text: count === 0 ? text : out, count };
}

interface Patch {
  readonly target: Record<string, unknown>;
  readonly key: string;
  readonly before: string;
  readonly after: string;
}

/** What each call that was restored needs to put back, by the event object Pi handed to the handler. */
const undoable = new WeakMap<object, readonly Patch[]>();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A string field read without running a getter: an accessor is not ours to call. */
function textField(target: Record<string, unknown>, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function collect(
  target: Record<string, unknown>,
  keys: readonly string[],
  values: ReadonlyMap<string, string>,
  into: Patch[],
): number {
  let count = 0;
  for (const key of keys) {
    const before = textField(target, key);
    if (before === undefined) continue;
    const done = restoreMarkers(before, values);
    if (done.count === 0) continue;
    count += done.count;
    into.push({ target, key, before, after: done.text });
  }
  return count;
}

function assign(patch: Patch, text: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(patch.target, patch.key);
  if (!descriptor?.writable) throw new TypeError("an input field holding a secret marker cannot be written");
  patch.target[patch.key] = text;
}

/**
 * M5R119: restores markers into Pi's own `write` and `edit` inputs, in place. Anything else (a command, an MCP or
 * extension tool, a built-in name another source registered) is left alone: restoring there is an exfiltration
 * primitive. All fields are checked before the first is written, and a write that fails puts back the ones done.
 */
export function restoreInput(call: CallFacts, values: ReadonlyMap<string, string>): number {
  const { toolName, input } = call.event;
  if (!call.kind.builtin || (toolName !== "write" && toolName !== "edit") || !isRecord(input)) return 0;
  const patches: Patch[] = [];
  let count = 0;
  if (toolName === "write") count += collect(input, ["content"], values, patches);
  else {
    count += collect(input, ["oldText", "newText"], values, patches);
    const list = Object.getOwnPropertyDescriptor(input, "edits")?.value as unknown;
    if (Array.isArray(list))
      for (const item of list as unknown[])
        if (isRecord(item)) count += collect(item, ["oldText", "newText"], values, patches);
  }
  if (patches.length === 0) return 0;
  const done: Patch[] = [];
  try {
    for (const patch of patches) {
      assign(patch, patch.after);
      done.push(patch);
    }
  } catch (error) {
    for (const patch of done) patch.target[patch.key] = patch.before;
    throw error;
  }
  undoable.set(call.event, patches);
  return count;
}

/** Puts the markers back into a call that was restored; used when the call is blocked after all. */
export function unrestoreInput(call: CallFacts): void {
  const patches = undoable.get(call.event);
  undoable.delete(call.event);
  for (const patch of patches ?? []) {
    try {
      patch.target[patch.key] = patch.before;
    } catch {
      process.stderr.write("pi-host: a restored input could not be put back\n");
    }
  }
}

export const restoreStage =
  (values: () => ReadonlyMap<string, string>): Stages["restore"] =>
  (call) =>
    restoreInput(call, values());

/** The call entry with the stage-06 verdict of a restoration appended. */
export function withRestored(entry: CallAuditEntry, restored: number): CallAuditEntry {
  if (restored <= 0) return entry;
  const reason = `${restored} secret marker${restored === 1 ? "" : "s"} restored`;
  return { ...entry, stages: [...entry.stages, { stage: "06", outcome: "acted", reason }] };
}
