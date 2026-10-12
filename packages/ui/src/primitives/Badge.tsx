export function Badge({ count, label }: { readonly count: number; readonly label: string }) {
  const whole = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return (
    <span
      data-slot="badge"
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-attn-fill px-1 font-mono text-label font-bold tabular-nums text-attn-ink"
    >
      <span aria-hidden>{whole > 99 ? "99+" : whole}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
