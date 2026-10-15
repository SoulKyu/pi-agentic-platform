const MAX_SOURCE = 64;

/** The text is kept verbatim; only the source is made safe for an attribute. `id` is unguessable (the caller's crypto). */
export function fenceText(text: string, source: string, id: string): string {
  const safe = source.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, MAX_SOURCE) || "_";
  return `<untrusted source="${safe}" id="${id}">\n${text}\n</untrusted id="${id}">`;
}
