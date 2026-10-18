import { CODEMODE_TOOL, type NestedCallView } from "../../stores/nested-calls.ts";
import type { FencePart } from "./fence.vm.ts";
import type { ToolItem } from "./transcript.vm.ts";

/** Pi's result starts with these three lines (recorded in spikes/s4/results-codemode.json); input it rejected has none. */
const HEADER = /^Script (completed|failed)\nWall time ([0-9.]+) seconds\nOutput:(?:\n|$)/;
const SEPARATOR = /^==> text \d+\/\d+ <==$/m;

export interface CodemodeView {
  readonly preview: string;
  readonly code: string;
  /** Undefined when the result carries no record of nested calls. */
  readonly calls: readonly NestedCallView[] | undefined;
  /** "0.1 s" from the result's header, null while it is unknown. */
  readonly wall: string | null;
}

/** The first line that says what the script does: blank and comment-only lines are skipped. */
export function previewLine(code: string): string {
  let inBlock = false;
  for (const line of code.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (inBlock) {
      inBlock = !trimmed.includes("*/");
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      inBlock = !trimmed.includes("*/");
      continue;
    }
    return trimmed;
  }
  return "";
}

const wallOf = (seconds: string): string => `${seconds} s`;

/** The wall time of a result text, null when it has no header. */
export function wallTime(text: string): string | null {
  const found = HEADER.exec(text);
  return found?.[2] === undefined ? null : wallOf(found[2]);
}

/**
 * The output without its header, which the card shows as its status and wall time. The header is the start of the
 * result, so inside a fence it is the start of the fence's text.
 */
export function withoutHeader(parts: readonly FencePart[]): {
  parts: readonly FencePart[];
  wall: string | null;
  failedHeader: boolean;
} {
  const [first, ...rest] = parts;
  const found = first ? HEADER.exec(first.text) : null;
  if (!first || !found) return { parts, wall: null, failedHeader: false };
  const text = first.text.slice(found[0].length);
  const kept: FencePart[] = text === "" ? rest : [{ ...first, text }, ...rest];
  return { parts: kept, wall: wallOf(found[2] ?? ""), failedHeader: found[1] === "failed" };
}

/** The output items (`==> text i/n <==`) as separate blocks, without the separators. */
export function sectionsOf(text: string): string[] {
  return text
    .split(SEPARATOR)
    .map((section) => section.replace(/^\r?\n|\r?\n$/g, ""))
    .filter((section) => section.trim() !== "");
}

/** The script, whole when the loaded arguments parse (the wire cuts long ones), else as the wire carried it. */
function scriptOf(wire: string, loadedArgs: string | null, argsTruncated: boolean): string {
  if (!argsTruncated || loadedArgs === null) return wire;
  try {
    const code = (JSON.parse(loadedArgs) as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : wire;
  } catch {
    return wire;
  }
}

/** The dedicated card's data, or null: the tool is not codemode or its arguments carry no `code` string (generic card). */
export function codemodeView(item: ToolItem, loadedArgs: string | null): CodemodeView | null {
  if (item.name !== CODEMODE_TOOL || item.code === undefined) return null;
  const code = scriptOf(item.code, loadedArgs, item.argsTruncated);
  return { preview: previewLine(code), code, calls: item.nested, wall: wallTime(item.preview) };
}

export const durationText = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
