import type { ReactNode } from "react";

/** DESIGN.md §9.1: dashed frame, one sentence of purpose, one primary action. */
export function EmptyState({
  title,
  purpose,
  action,
}: {
  readonly title: string;
  readonly purpose: string;
  readonly action?: ReactNode;
}) {
  return (
    <section
      data-slot="empty-state"
      className="flex flex-col items-start gap-s2 rounded-md border border-dashed border-border-strong p-s5"
    >
      <h2 className="text-h2 text-fg">{title}</h2>
      <p className="text-ui text-muted">{purpose}</p>
      {action ? <div className="mt-s1">{action}</div> : null}
    </section>
  );
}
