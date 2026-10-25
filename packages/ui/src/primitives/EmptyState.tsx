import type { ReactNode } from "react";
import { CodeText } from "./CodeText.tsx";

/** DESIGN.md §9.1: dashed frame, one sentence of purpose, one primary action. */
export function EmptyState({
  title,
  purpose,
  action,
  level,
}: {
  readonly title: string;
  readonly purpose: string;
  readonly action?: ReactNode;
  /** Heading level: 3 inside a section that has its own h2. */
  readonly level?: 2 | 3;
}) {
  const Title = level === 3 ? "h3" : "h2";
  return (
    <section
      data-slot="empty-state"
      className="flex flex-col items-start gap-s2 rounded-md border border-dashed border-border-strong p-s5"
    >
      <Title className="text-h2 text-fg">{title}</Title>
      <p className="text-ui text-muted">
        <CodeText text={purpose} />
      </p>
      {action ? <div className="mt-s1">{action}</div> : null}
    </section>
  );
}
