/** One call a tool made to other tools, as Pi records it on the tool's result (`nestedCalls`): metadata only, never results. */
export interface NestedCallView {
  readonly name: string;
  /** The arguments as one line of JSON, cut; "" when Pi left them out. */
  readonly args: string;
  /** Pi's `unfinished` (still running when the script ended) is shown as cancelled. */
  readonly status: "ok" | "error" | "cancelled";
  readonly durationMs: number | null;
  readonly error: string | null;
}

const MAX_CALLS = 256;
const MAX_ARGS = 200;
const MAX_NAME = 64;
const MAX_ERROR = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cut = (text: string, max: number): string =>
  text.length > max ? `${[...text.slice(0, max * 2)].slice(0, max).join("")}…` : text;

function toCall(raw: unknown): NestedCallView | null {
  if (!isRecord(raw) || typeof raw.name !== "string") return null;
  const status = raw.status === "ok" ? "ok" : raw.status === "error" ? "error" : "cancelled";
  const args = isRecord(raw.arguments) ? (JSON.stringify(raw.arguments) ?? "") : "";
  const duration = raw.durationMs;
  return {
    name: cut(raw.name, MAX_NAME),
    args: cut(args, MAX_ARGS),
    status,
    durationMs: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
    error: typeof raw.error === "string" && raw.error !== "" ? cut(raw.error, MAX_ERROR) : null,
  };
}

/** The nested calls of a tool result; undefined when the message has none. Read defensively: the row is untrusted JSON. */
export function nestedCallsOf(raw: unknown): readonly NestedCallView[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.calls)) return undefined;
  return raw.calls.slice(0, MAX_CALLS).flatMap((call) => {
    const view = toCall(call);
    return view ? [view] : [];
  });
}
