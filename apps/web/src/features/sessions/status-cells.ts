import type { StatusEntry } from "@pap/contracts";
import { plainText } from "./ansi.ts";

export type StatusCell =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | { readonly kind: "command"; readonly key: string; readonly command: string; readonly label: string };

const COMMAND_PREFIX = "command:";
/** Runs of spaces and tabs become one space and the line is trimmed; escape sequences carry none, so ANSI survives. */
const tidy = (text: string): string => text.replace(/[ \t]+/g, " ").trim();

/**
 * The cells of the status bar: `command:/…` keys become buttons (label = the extension's text, else the command), the
 * rest stay text with their ANSI. Buttons come first, each group in key order; a status with no visible text gets no cell.
 * The command is cleaned of control and bidi characters: what the button shows is what it sends.
 */
export function statusCells(statuses: readonly StatusEntry[]): StatusCell[] {
  const commands: StatusCell[] = [];
  const texts: StatusCell[] = [];
  for (const { key, text } of statuses) {
    const tidied = tidy(text);
    const label = plainText(tidied);
    const command = key.startsWith(COMMAND_PREFIX) ? tidy(plainText(key.slice(COMMAND_PREFIX.length))) : "";
    if (command.startsWith("/") && command.length > 1) {
      commands.push({ kind: "command", key, command, label: label === "" ? command : label });
    } else if (label !== "") {
      texts.push({ kind: "text", key, text: tidied });
    }
  }
  const byKey = (a: StatusCell, b: StatusCell) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return [...commands.sort(byKey), ...texts.sort(byKey)];
}
