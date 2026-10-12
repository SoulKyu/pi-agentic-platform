/** An inline line with a mono label, not sticky (DESIGN.md §9.2, pw a1ba117). */
export function DaySeparator({ label }: { readonly label: string }) {
  return (
    <div
      data-slot="day-separator"
      role="separator"
      aria-label={label}
      className="flex items-center gap-s2 py-s2"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span aria-hidden className="label-hud text-muted">
        {label}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
