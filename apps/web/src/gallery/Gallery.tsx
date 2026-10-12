import "./register-gallery-catalog.ts";
import { DENSITIES, Segmented, Switch, THEMES, TooltipProvider, type Density, type ThemeName } from "@pap/ui";
import { useState } from "react";
import { useT } from "../i18n/index.ts";
import { GalleryFrame } from "./GalleryFrame.tsx";
import { AiSection } from "./sections/AiSection.tsx";
import { BrandSection } from "./sections/BrandSection.tsx";
import { PrimitivesSection } from "./sections/PrimitivesSection.tsx";

const FALLBACK = { theme: "night", density: "compact" } as const;

const pick = <V extends string>(allowed: readonly V[], value: string | null, fallback: V): V =>
  allowed.find((one) => one === value) ?? fallback;

/** `?theme=&density=&all=`; an unknown value falls back to night and compact. */
function fromAddress(): { theme: ThemeName; density: Density; all: boolean } {
  const query = new URLSearchParams(window.location.search);
  return {
    theme: pick(THEMES, query.get("theme"), FALLBACK.theme),
    density: pick(DENSITIES, query.get("density"), FALLBACK.density),
    all: query.get("all") === "1",
  };
}

/** The dev-only gallery (ADR 0011): every component in the chosen theme and density, or in all nine. */
export function Gallery() {
  const t = useT();
  const [start] = useState(fromAddress);
  const [theme, setTheme] = useState<ThemeName>(start.theme);
  const [density, setDensity] = useState<Density>(start.density);
  const [all, setAll] = useState(start.all);
  const frames = all
    ? THEMES.flatMap((one) => DENSITIES.map((other) => ({ theme: one, density: other })))
    : [{ theme, density }];
  return (
    <TooltipProvider>
      <div data-gallery className="flex flex-col gap-s4 overflow-auto p-s4">
        <header className="flex flex-col gap-s2">
          <h1 className="text-h1 text-fg">{t("gallery.heading")}</h1>
          <p className="text-ui text-muted">{t("gallery.intro")}</p>
          <div role="group" aria-label={t("gallery.controls")} className="flex flex-wrap items-center gap-s4">
            <Segmented<ThemeName>
              label={t("gallery.theme")}
              value={theme}
              options={THEMES.map((value) => ({ value, label: t(`gallery.themeName.${value}`) }))}
              onChange={setTheme}
            />
            <Segmented<Density>
              label={t("gallery.density")}
              value={density}
              options={DENSITIES.map((value) => ({ value, label: t(`gallery.densityName.${value}`) }))}
              onChange={setDensity}
            />
            <Switch label={t("gallery.all")} checked={all} onChange={setAll} />
          </div>
        </header>
        {frames.map((frame) => (
          <GalleryFrame key={`${frame.theme}:${frame.density}`} theme={frame.theme} density={frame.density}>
            <p className="label-hud text-muted">
              {t("gallery.frame", {
                theme: t(`gallery.themeName.${frame.theme}`),
                density: t(`gallery.densityName.${frame.density}`),
              })}
            </p>
            <BrandSection />
            <PrimitivesSection />
            <AiSection />
          </GalleryFrame>
        ))}
      </div>
    </TooltipProvider>
  );
}
