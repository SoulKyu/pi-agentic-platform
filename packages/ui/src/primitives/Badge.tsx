export function Badge({ count, label }: { readonly count: number; readonly label: string }) {
  return (
    <span
      data-slot="badge"
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-attn-fill px-1 font-mono text-label font-bold tabular-nums text-attn-ink"
    >
      <span aria-hidden>{count > 99 ? "99+" : count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
