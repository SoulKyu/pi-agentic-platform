import type { ReactNode } from "react";
import { cn } from "@pap/ui";

/** One component instance: the export's name is the caption and the marker the tests look for. */
export function GalleryItem({
  name,
  children,
  column,
}: {
  readonly name: string;
  readonly children: ReactNode;
  readonly column?: boolean;
}) {
  return (
    <figure
      data-gallery-item={name}
      className="flex min-w-0 flex-col gap-s2 rounded-md border border-border p-s3"
    >
      <div className={cn("flex gap-s2", column === true ? "flex-col" : "flex-wrap items-center")}>
        {children}
      </div>
      <figcaption className="font-mono text-label text-muted">{name}</figcaption>
    </figure>
  );
}

export function GallerySection({
  id,
  title,
  children,
}: {
  readonly id: "brand" | "primitives" | "ai";
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section data-gallery-section={id} className="flex flex-col gap-s3">
      <h2 className="text-h2 text-fg">{title}</h2>
      <div className="grid grid-cols-1 gap-s3 md:grid-cols-2">{children}</div>
    </section>
  );
}
