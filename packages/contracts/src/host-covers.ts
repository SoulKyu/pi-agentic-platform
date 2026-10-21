import { parseHostEntry, tryParseHostEntry } from "./host-entry.ts";

/** The name-only rule, for an entry that is not a valid host entry (a stored legacy one, a shorthand in a test). A wildcard never covers an exact entry (AVM2-E12). */
const coversByName = (list: readonly string[], entry: string): boolean =>
  list.includes(entry) ||
  list.some((own) => own.startsWith("*.") && entry.startsWith("*.") && entry.slice(2).endsWith(own.slice(1)));
/** Whether `list` reaches every host and port `entry` names (an exact entry is covered by itself, `*.x` by `*.x` or a wider `*.`; no port: 80 and 443). */
export const covers = (list: readonly string[], entry: string): boolean => {
  const wanted = tryParseHostEntry(entry);
  if (!wanted || list.some((own) => tryParseHostEntry(own) === null)) return coversByName(list, entry);
  return list.some((own) => {
    const mine = parseHostEntry(own);
    if (!wanted.ports.every((port) => mine.ports.includes(port))) return false;
    if (!mine.wildcard) return !wanted.wildcard && mine.host === wanted.host;
    // AVM2-E12: an exact entry reaches private ranges a wildcard cannot, so a wildcard never covers an exact entry.
    return wanted.wildcard && (wanted.host.endsWith(`.${mine.host}`) || wanted.host === mine.host);
  });
};
