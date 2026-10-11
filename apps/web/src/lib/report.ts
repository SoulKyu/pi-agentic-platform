export type ClientIssue =
  | "storage_refused"
  | "boot_cache_refused"
  | "appearance_boot_failed"
  | "setting_load_failed"
  | "setting_save_failed"
  | "keybindings_invalid"
  | "sessions_list_failed"
  | "lazy_chunk_failed"
  | "command_failed"
  | "workspace_invalid";

const QUIET_MS = 10_000;
// Bounded by the closed union above.
const last = new Map<ClientIssue, number>();
const CONSOLE = { warn: (line: string) => console.warn(line), now: () => Date.now() };

/** A client-side failure nobody sees on screen: one bounded console line per code per 10 s, never user data. */
export function reportClientIssue(
  code: ClientIssue,
  deps: { warn?(line: string): void; now?(): number } = {},
): void {
  const warn = deps.warn ?? CONSOLE.warn;
  const now = (deps.now ?? CONSOLE.now)();
  const previous = last.get(code);
  if (previous !== undefined && now - previous < QUIET_MS) return;
  last.set(code, now);
  warn(`pap: ${code}`);
}
