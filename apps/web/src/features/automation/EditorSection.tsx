import { Heading } from "@pap/ui";
import type { ReactNode } from "react";
import type { Draft } from "./editor.vm.ts";

/** What every section of the form receives: the draft, a patch, and the shown errors keyed by contract path. */
export interface SectionProps {
  readonly draft: Draft;
  set(patch: Partial<Draft>): void;
  readonly errors: Readonly<Record<string, string>>;
}

/** One framed block of the editor (board 11 §1: a raised surface, an agent-coloured HUD title). */
export function EditorSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-s3 rounded-md border border-border-strong bg-surface p-s3">
      <Heading level={3} variant="card" tone="agent">
        {title}
      </Heading>
      {children}
    </section>
  );
}
