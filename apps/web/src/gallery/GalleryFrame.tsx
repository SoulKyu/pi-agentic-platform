import type { Density, ThemeName } from "@pap/ui";
import type { ReactNode } from "react";

/** Every token selector is an attribute selector (Task 1a): these two attributes re-theme the subtree. */
export function GalleryFrame({
  theme,
  density,
  children,
}: {
  readonly theme: ThemeName;
  readonly density: Density;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-slot="gallery-frame"
      data-theme={theme}
      data-density={density}
      className="bg-grid text-fg flex flex-col gap-s4 rounded-md border border-border-strong p-s4"
    >
      {children}
    </div>
  );
}
