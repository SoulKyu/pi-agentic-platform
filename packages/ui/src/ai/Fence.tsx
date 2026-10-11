import type { ReactNode } from "react";

/** External content, fenced and labelled with its source (DESIGN.md §2, §11, decision 29). */
export function Fence({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <figure
      data-slot="fence"
      className="flex flex-col gap-s1 rounded-md border border-dashed border-attn p-s2"
    >
      <figcaption className="label-hud text-attn">{label}</figcaption>
      <div className="whitespace-pre-wrap break-words font-mono text-code text-muted">{children}</div>
    </figure>
  );
}
