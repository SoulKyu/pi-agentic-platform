import { useId, type ReactNode } from "react";

/** A titled group of controls that says which scope it writes to. */
export function AppearanceSection({
  title,
  scope,
  children,
}: {
  readonly title: string;
  readonly scope: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-s3">
      <header className="flex items-baseline justify-between gap-s2 border-b border-border pb-s1">
        <h3 id={id} className="label-hud text-fg">
          {title}
        </h3>
        <span className="text-ui text-muted">{scope}</span>
      </header>
      {children}
    </section>
  );
}
