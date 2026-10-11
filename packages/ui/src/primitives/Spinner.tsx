import { IconSpinner } from "../icons.ts";

/** 1–3 s feedback (DESIGN.md §7.3). It stops turning under reduced motion and still reads as "working". */
export function Spinner({ label }: { readonly label?: string }) {
  return (
    <span
      data-slot="spinner"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="inline-flex animate-spin"
    >
      <IconSpinner size={14} strokeWidth={1.5} aria-hidden />
    </span>
  );
}
