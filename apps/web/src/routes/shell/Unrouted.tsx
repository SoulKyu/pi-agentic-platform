import { useRouterState } from "@tanstack/react-router";
import { landingSegmentOf } from "../../features/notifications/landing-path.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { ROUTES } from "./landing-route.ts";
import { NotFound } from "./NotFound.tsx";

const loadLanding = () => import("../../features/notifications/Landing.tsx");

/** What the main area shows for a path that names no item: the `/n/<id>` landing (lazy), or the not-found screen. */
export function Unrouted() {
  const t = useT();
  const lazyText = useLazyFailureText();
  const segment = useRouterState({ select: (state) => landingSegmentOf(state.location.pathname) });
  if (segment === null) return <NotFound />;
  return (
    <LazyPanel
      key={segment}
      text={lazyText}
      load={loadLanding}
      open
      props={{ id: segment, routes: ROUTES }}
      fallback={
        <p role="status" data-landing-loading className="w-full p-s4 text-muted">
          {t("app.loading")}
        </p>
      }
      onFailed={() => {}}
    />
  );
}
