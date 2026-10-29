import { cn } from "../cn.ts";

/** UX-2 §7, decision 139: a service's page runs scripts, submits its own forms and downloads. Never same-origin, never the top window, never a popup. */
export const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-downloads";
/** UX-2 §8, decision 4: an HTML artifact runs scripts and nothing else. */
export const ARTIFACT_SANDBOX = "allow-scripts";

export interface SandboxedFrameProps {
  /** A URL of the untrusted origin; the app never frames anything else (its CSP `frame-src` names that origin only). */
  readonly src: string;
  readonly sandbox: typeof PREVIEW_SANDBOX | typeof ARTIFACT_SANDBOX;
  /** `UNTRUSTED · preview <name>`: drawn outside the frame, above it, always visible (DESIGN.md §2). */
  readonly label: string;
  /** The frame's accessible name. */
  readonly title: string;
  readonly className?: string;
}

/**
 * Content an agent served, in the dashed untrusted frame. The label is pap's own text outside the iframe, so a page cannot
 * draw over it or pass for pap's UI; the iframe sends no referrer (the URL is a capability).
 */
export function SandboxedFrame({ src, sandbox, label, title, className }: SandboxedFrameProps) {
  return (
    <figure
      data-slot="sandboxed-frame"
      className="flex min-h-0 flex-1 flex-col gap-s1 rounded-md border border-dashed border-attn p-s1"
    >
      <figcaption className="label-hud text-attn">{label}</figcaption>
      <iframe
        src={src}
        sandbox={sandbox}
        referrerPolicy="no-referrer"
        title={title}
        className={cn("min-h-0 w-full flex-1 rounded-sm border-0 bg-surface", className)}
      />
    </figure>
  );
}
