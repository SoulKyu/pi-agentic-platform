interface ProjectHeadingProps {
  readonly id: string;
  readonly name: string;
  /** The project's folder; absent for the group of sessions without a project. */
  readonly root: string | null;
  readonly count: number;
}

/** A project's name (the heading), its folder and how many active sessions it has. */
export function ProjectHeading({ id, name, root, count }: ProjectHeadingProps) {
  return (
    <div className="flex flex-col gap-s1">
      <div className="flex items-baseline justify-between gap-s2">
        <h3 id={id} className="min-w-0 break-words text-ui font-semibold">
          {name}
        </h3>
        <span className="font-mono text-label text-muted tabular-nums">{count}</span>
      </div>
      {root === null ? null : <p className="break-all font-mono text-code text-dim">{root}</p>}
    </div>
  );
}
