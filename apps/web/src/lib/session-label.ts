/** The last folder of a path ("" for the root). */
export const basename = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? "";

/** What every list shows for a session (M4R88): its name, else its first words, else its folder; "" when none is known. */
export const sessionLabel = (
  session: { readonly name: string | null; readonly preview?: string | null; readonly cwd: string } | null,
): string => session?.name ?? session?.preview ?? basename(session?.cwd ?? "");
