import { Button, EmptyState } from "@pap/ui";
import { Component, Suspense, type ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { RouteErrorScreen } from "../RouteError.tsx";

// What browsers throw when a lazy chunk is gone after an update: Chromium, Safari, Firefox, bundler wording.
const STALE_CHUNK =
  /dynamically imported module|importing a module script failed|error loading dynamically|ChunkLoadError/i;

export const isStaleChunk = (error: unknown): boolean =>
  error instanceof Error && (STALE_CHUNK.test(error.message) || error.name === "ChunkLoadError");

function Updated() {
  const t = useT();
  return (
    <EmptyState
      title={t("shell.stale.title")}
      purpose={t("shell.stale.purpose")}
      action={<Button onClick={() => window.location.reload()}>{t("shell.reload")}</Button>}
    />
  );
}

function Loading() {
  const t = useT();
  return <p className="p-s4 text-ui text-muted">{t("app.loading")}</p>;
}

interface State {
  readonly failure: "stale" | "broken" | null;
}

/** Around every pane: lazy screens get a loading line, and a failing one a translated screen, never a blank pane. */
export class PaneBoundary extends Component<{ readonly children: ReactNode }, State> {
  override state: State = { failure: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failure: isStaleChunk(error) ? "stale" : "broken" };
  }

  override componentDidCatch(error: unknown): void {
    reportClientIssue(isStaleChunk(error) ? "lazy_chunk_failed" : "render_failed");
  }

  override render(): ReactNode {
    if (this.state.failure === "stale") return <Updated />;
    if (this.state.failure === "broken") return <RouteErrorScreen />;
    return <Suspense fallback={<Loading />}>{this.props.children}</Suspense>;
  }
}
