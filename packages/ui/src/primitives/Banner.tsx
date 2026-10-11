import type { ReactNode } from "react";
import { cn } from "../cn.ts";

export type BannerTone = "crash" | "capacity" | "offline" | "checkpoint";

const BANNER_TONES: Record<BannerTone, { readonly frame: string; readonly title: string }> = {
  crash: { frame: "border-err bg-surface", title: "text-err" },
  capacity: { frame: "border-border-strong bg-surface", title: "text-fg" },
  offline: { frame: "border-dashed border-border-strong bg-surface", title: "text-muted" },
  checkpoint: { frame: "border-you-line bg-you-tint", title: "text-you-text" },
};

export interface BannerProps {
  readonly tone: BannerTone;
  readonly title: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}

/** DESIGN.md §9.1 and §11: say what happened, what is intact, what you can do. Crash is an alert, the rest status. */
export function Banner({ tone, title, children, actions }: BannerProps) {
  const style = BANNER_TONES[tone];
  return (
    <section
      data-slot="banner"
      data-tone={tone}
      role={tone === "crash" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-start justify-between gap-s2 rounded-md border px-s3 py-s2",
        style.frame,
      )}
    >
      <div className="flex min-w-0 flex-col gap-s1">
        <p className={cn("text-ui font-semibold", style.title)}>{title}</p>
        {children ? <div className="text-ui text-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-s2">{actions}</div> : null}
    </section>
  );
}
