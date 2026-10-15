import { escapeHidden } from "../../lib/escape-hidden.ts";

/** Script output as visible text: hidden characters become `\uXXXX`; line breaks and tabs stay, a log is made of them. */
export const visibleLog = (text: string): string =>
  text
    .split(/(\n|\t)/)
    .map((part) => (part === "\n" || part === "\t" ? part : escapeHidden(part)))
    .join("");
