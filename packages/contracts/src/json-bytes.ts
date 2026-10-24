const encoder = new TextEncoder();

/** A value's size as it goes on the wire: JSON bytes, never characters. */
export const sizeOf = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? "null").length;

/** A page of rows, fork points, queued texts or rules, in JSON bytes: well under the 1 MiB frame, which also holds the envelope (M2R54). */
export const PAGE_BYTES = 900_000;
