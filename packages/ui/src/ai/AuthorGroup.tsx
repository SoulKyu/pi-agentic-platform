import type { ReactNode } from "react";
import { cn } from "../cn.ts";

const NAME_TONES = { agent: "text-agent", you: "text-you" } as const;

/** Consecutive messages of one author under one avatar and header (pw: conversation view, GroupHeader). */
export function AuthorGroup({
  author,
  name,
  avatar,
  meta,
  children,
}: {
  readonly author: keyof typeof NAME_TONES;
  readonly name: string;
  readonly avatar?: ReactNode;
  readonly meta?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section data-slot="author-group" data-author={author} aria-label={name} className="flex gap-s2">
      {avatar ? <div className="shrink-0 pt-0.5">{avatar}</div> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-s1">
        <header className="flex items-baseline gap-s2">
          <span className={cn("label-hud", NAME_TONES[author])}>{name}</span>
          {meta ? <span className="font-mono text-label tabular-nums text-muted">{meta}</span> : null}
        </header>
        {children}
      </div>
    </section>
  );
}
