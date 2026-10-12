import { Mark, Wordmark } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { SAMPLE } from "../fixtures.ts";
import { GalleryItem, GallerySection } from "../GalleryItem.tsx";

export function BrandSection() {
  const t = useT();
  return (
    <GallerySection id="brand" title={t("gallery.section.brand")}>
      <GalleryItem name="Mark">
        <Mark size={16} />
        <Mark size={24} />
        <Mark size={48} label={SAMPLE.markMark} />
        <Mark size={48} mode="day" />
      </GalleryItem>
      <GalleryItem name="Wordmark">
        <Wordmark name={SAMPLE.wordmark} />
        <Wordmark name={SAMPLE.wordmark} tagline={SAMPLE.tagline} />
      </GalleryItem>
    </GallerySection>
  );
}
