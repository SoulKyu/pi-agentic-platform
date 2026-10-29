import { createContext } from "react";

/** What the app made of a reply's `![alt](src)`: an image to show, a file to open, or nothing (the alt text stands in). */
export type ImageResult =
  | { readonly kind: "image"; readonly url: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "text" };

/** What a reply may show beyond text (images of the box, math, diagrams, HTML previews); the app supplies it, the renderer knows nothing of sessions, folders or requests. */
export interface RichReplies {
  /** Async: resolves the reply's `![alt](src)`; `signal` aborts the lookup when the image leaves the page. Absent: every image is `[image: alt]`. */
  image?(src: string, signal?: AbortSignal): Promise<ImageResult>;
  /** A lazy chunk of the reply (math) failed to load: the app reports it; the source stays on screen. */
  onLoadError?(): void;
  openFile?(path: string): void;
  /** Mints an artifact for the html fence starting at `offset` in the message text and answers its URL; absent: no PREVIEW. */
  artifact?(offset: number, code: string): Promise<string>;
  /** Whether the fence at `offset` shown as `code` has an artifact (a top-level fence of a finished message whose scanned body is that very code); only then PREVIEW shows. */
  canArtifact?(offset: number, code: string): boolean;
  readonly labels: {
    readonly image: (alt: string) => string;
    readonly openFile: (path: string) => string;
    readonly preview: string;
    readonly hide: string;
    readonly artifactFrame: string;
    readonly artifactTitle: string;
    readonly mermaidError: string;
    readonly mermaidTooLarge: string;
    readonly diagram: string;
  };
}

export const RichRepliesContext = createContext<RichReplies | undefined>(undefined);
