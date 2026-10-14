import { cn } from "../cn.ts";

export type ChipTone = "run" | "ok" | "att" | "err" | "mut" | "ext";

const CHIP_TONES: Record<ChipTone, string> = {
  run: "border-agent text-agent",
  ok: "border-ok text-ok",
  att: "border-attn text-attn",
  err: "border-err text-err",
  mut: "border-border-strong text-muted",
  ext: "border-dashed border-attn text-attn",
};

/** Status chip: a mono upper-case word, optional dot; the word is what screen readers read (DESIGN.md §12). */
// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function Chip({
  tone,
  label,
  dot,
}: {
  readonly tone: ChipTone;
  readonly label: string;
  readonly dot?: boolean;
}) {
  return (
    <span
      data-slot="chip"
      data-tone={tone}
      className={cn(
        "inline-flex h-4.5 items-center gap-s1 rounded-sm border px-s1 label-hud",
        CHIP_TONES[tone],
      )}
    >
      {(dot ?? false) ? (
        <span data-slot="chip-dot" aria-hidden className="size-1.5 rounded-full bg-current" />
      ) : null}
      {label}
    </span>
  );
}
