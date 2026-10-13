import { type ApprovalRequestRecord, Dialog, type UiRequestRecord } from "@pap/contracts";
import { z } from "zod";
import { sizeOf } from "../../kernel/json-bytes.ts";
import { cutUnits } from "../../kernel/text.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const DECORATION_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
const MAX_DIALOGS = 64;
const MAX_DIALOG_BYTES = 8 * 1024 * 1024;
/** One dialog as sent: the socket allows 1 MiB per frame, and the frame's own fields need a few hundred bytes. */
export const DIALOG_FRAME_BYTES = 1_000_000;

const maxLengthOf = (schema: z.ZodType): number => {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  const max = (inner as z.ZodString).maxLength;
  if (typeof max !== "number") throw new Error("every Dialog text field needs a maximum length");
  return max;
};
// Read from the contract, so a limit changed there is the limit applied here.
const TEXT_LIMITS = {
  title: maxLengthOf(Dialog.shape.title),
  message: maxLengthOf(Dialog.shape.message),
  placeholder: maxLengthOf(Dialog.shape.placeholder),
  prefill: maxLengthOf(Dialog.shape.prefill),
} as const;
type TextField = keyof typeof TEXT_LIMITS;
const TEXT_FIELDS = Object.keys(TEXT_LIMITS) as TextField[];
const MAX_OPTIONS = 100;
const MAX_OPTION_CHARS = maxLengthOf(Dialog.shape.options.unwrap().element);

export type CancelReason = "unknown_method" | "malformed" | "too_large" | "limit" | "collision";
export type DialogVerdict =
  { kind: "opened"; dialog: Dialog } | { kind: "cancel"; reason: CancelReason } | { kind: "decoration" };

/** What an approval grants if the user answers "session" or "always" (Task 14b), kept beside its dialog. */
export interface Grant {
  readonly tool: string;
  readonly key: string;
  /** What the "always" list shows for the rule: the call as the card showed it, cut to 4096 characters. */
  readonly label: string;
}
const MAX_LABEL_CHARS = 4096;

export interface DialogRegistry {
  offer(request: UiRequestRecord): DialogVerdict;
  /** The policy's own question. Never cut (R86): one that is malformed or does not fit is cancelled. */
  offerApproval(record: ApprovalRequestRecord): DialogVerdict;
  /** The open dialog, without taking it. */
  peek(id: string): Dialog | null;
  take(id: string): Dialog | null;
  /** Takes the dialog with the grant of an approval (null for any other dialog). */
  takeEntry(id: string): { dialog: Dialog; grant: Grant | null } | null;
  list(): Dialog[];
  clear(): Dialog[];
}

const cancel = (reason: CancelReason): DialogVerdict => ({ kind: "cancel", reason });

/** `max` UTF-16 units at most, the last one marking the cut, never half a surrogate pair. */
const cut = (text: string, max: number): string => cutUnits(text, max, "…");

// Text fields of the request that are not text make the whole dialog malformed; `undefined` means "not given".
function textOf(raw: Record<string, unknown>, field: TextField): string | undefined | null {
  const value = raw[field];
  if (value === undefined) return undefined;
  return typeof value === "string" ? cut(value, TEXT_LIMITS[field]) : null;
}

type Built = { dialog: Dialog } | { reason: CancelReason };

function build(request: UiRequestRecord): Built {
  const raw: Record<string, unknown> = request;
  const text = Object.fromEntries(TEXT_FIELDS.map((field) => [field, textOf(raw, field)] as const));
  if (
    typeof text.title !== "string" ||
    text.message === null ||
    text.placeholder === null ||
    text.prefill === null
  ) {
    return { reason: "malformed" };
  }
  let options: string[] | undefined;
  if (request.method === "select") {
    const given = raw.options;
    if (!Array.isArray(given) || !given.every((option) => typeof option === "string")) {
      return { reason: "malformed" };
    }
    // Cutting an option would change the value the extension is waiting for, so one that is too long is no dialog.
    if (given.length > MAX_OPTIONS || given.some((option: string) => option.length > MAX_OPTION_CHARS)) {
      return { reason: "too_large" };
    }
    options = given as string[];
  }
  const timeout =
    Number.isSafeInteger(raw.timeout) && (raw.timeout as number) > 0 ? (raw.timeout as number) : undefined;
  const parsed = Dialog.safeParse({
    id: request.id,
    method: request.method,
    title: text.title,
    ...(text.message === undefined ? {} : { message: text.message }),
    ...(options === undefined ? {} : { options }),
    ...(text.placeholder === undefined ? {} : { placeholder: text.placeholder }),
    ...(text.prefill === undefined ? {} : { prefill: text.prefill }),
    ...(timeout === undefined ? {} : { timeout }),
  });
  return parsed.success ? { dialog: parsed.data } : { reason: "malformed" };
}

const longestText = (dialog: Dialog): TextField | null => {
  let best: TextField | null = null;
  let bestLength = 1;
  for (const field of TEXT_FIELDS) {
    const length = dialog[field]?.length ?? 0;
    if (length > bestLength) {
      best = field;
      bestLength = length;
    }
  }
  return best;
};

// A frame holds at most 1 MiB, and a character can take up to six bytes of it once escaped, so the longest text
// field is cut by the share of its own bytes that is over, then measured again.
function fitFrame(dialog: Dialog): Dialog | null {
  let current = dialog;
  for (let attempt = 0; attempt < 8; attempt++) {
    const excess = sizeOf(current) - DIALOG_FRAME_BYTES;
    if (excess <= 0) return current;
    const field = longestText(current);
    const text = field ? current[field] : undefined;
    if (!field || text === undefined) return null;
    const bytes = sizeOf(text);
    const keep = Math.max(1, Math.floor((text.length * Math.max(0, bytes - excess - 8)) / bytes));
    current = { ...current, [field]: cut(text, keep) };
  }
  return sizeOf(current) <= DIALOG_FRAME_BYTES ? current : null;
}

/** At most 4096 characters, never ending between the two halves of a surrogate pair. */
function labelOf(message: string): string {
  return cutUnits(message, MAX_LABEL_CHARS);
}

/** The card must show the whole call, so a request is the dialog as it is or no dialog (R86). */
function approvalDialog(record: ApprovalRequestRecord): Built {
  if (!record.answers?.length || !record.category) return { reason: "malformed" };
  const parsed = Dialog.safeParse({
    id: record.id,
    method: "approval",
    title: record.title,
    message: record.message,
    category: record.category,
    answers: record.answers,
  });
  if (!parsed.success) {
    const longer = (text: unknown, max: number) => typeof text === "string" && text.length > max;
    const tooLong = longer(record.title, TEXT_LIMITS.title) || longer(record.message, TEXT_LIMITS.message);
    return { reason: tooLong ? "too_large" : "malformed" };
  }
  return sizeOf(parsed.data) > DIALOG_FRAME_BYTES ? { reason: "too_large" } : { dialog: parsed.data };
}

export function createDialogRegistry(): DialogRegistry {
  const open = new Map<string, { dialog: Dialog; bytes: number; grant: Grant | null }>();
  let bytes = 0;
  function place(dialog: Dialog, grant: Grant | null): DialogVerdict {
    const size = sizeOf(dialog);
    // A dialog offered again under an id that is open replaces it, as it does in the worker.
    const replaced = open.get(dialog.id);
    // Only one extension's dialog replaces another's. An approval and a dialog of the other kind never share an id:
    // the newcomer is refused and the open one stays, so neither waiter is left without an answer.
    if (replaced && (replaced.dialog.method === "approval") !== (dialog.method === "approval")) {
      return cancel("collision");
    }
    if (
      open.size - (replaced ? 1 : 0) >= MAX_DIALOGS ||
      bytes - (replaced?.bytes ?? 0) + size > MAX_DIALOG_BYTES
    ) {
      return cancel("limit");
    }
    bytes += size - (replaced?.bytes ?? 0);
    open.set(dialog.id, { dialog, bytes: size, grant });
    return { kind: "opened", dialog };
  }
  const registry: DialogRegistry = {
    offer(request) {
      if (DECORATION_METHODS.has(request.method)) return { kind: "decoration" };
      if (!DIALOG_METHODS.has(request.method)) return cancel("unknown_method");
      const built = build(request);
      if ("reason" in built) return cancel(built.reason);
      const dialog = fitFrame(built.dialog);
      return dialog ? place(dialog, null) : cancel("too_large");
    },
    offerApproval(record) {
      const built = approvalDialog(record);
      if ("reason" in built) return cancel(built.reason);
      return place(built.dialog, {
        tool: record.tool,
        key: record.key,
        label: labelOf(built.dialog.message ?? ""),
      });
    },
    peek: (id) => open.get(id)?.dialog ?? null,
    takeEntry(id) {
      const entry = open.get(id);
      if (!entry) return null;
      open.delete(id);
      bytes -= entry.bytes;
      return { dialog: entry.dialog, grant: entry.grant };
    },
    take: (id) => registry.takeEntry(id)?.dialog ?? null,
    list: () => [...open.values()].map((entry) => entry.dialog),
    clear() {
      const all = [...open.values()].map((entry) => entry.dialog);
      open.clear();
      bytes = 0;
      return all;
    },
  };
  return registry;
}
