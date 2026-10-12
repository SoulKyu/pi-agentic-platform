/** DESIGN.md §6.2: `pap` in Manrope 800, −0.02em, lower case; the optional tagline in mono upper case, muted. */
export function Wordmark({ name, tagline }: { readonly name: string; readonly tagline?: string }) {
  return (
    <span data-slot="wordmark" className="inline-flex items-baseline gap-s2">
      <span className="font-sans text-h1 font-extrabold tracking-display lowercase text-fg">{name}</span>
      {tagline ? <span className="label-hud text-muted">{tagline}</span> : null}
    </span>
  );
}
