import { useT } from "../../i18n/index.ts";
import { GallerySection } from "../GalleryItem.tsx";
import { DisplayFigures } from "./DisplayFigures.tsx";
import { FormFigures } from "./FormFigures.tsx";
import { OverlayFigures } from "./OverlayFigures.tsx";

export function PrimitivesSection() {
  const t = useT();
  return (
    <GallerySection id="primitives" title={t("gallery.section.primitives")}>
      <DisplayFigures />
      <FormFigures />
      <OverlayFigures />
    </GallerySection>
  );
}
