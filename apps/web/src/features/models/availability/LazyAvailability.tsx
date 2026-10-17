import type { ModelsOverview } from "@pap/contracts";
import { useLazyFailureText } from "../../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../../lib/lazy.tsx";

// The view (rows, preview, extension list, their catalog) is a chunk of its own (MP-RT-09: never a bare lazy).
const loadSection = () =>
  import("./AvailabilitySection.tsx").then((module) => ({ default: module.AvailabilitySection }));

/** The availability view, loaded when Settings > Models opens. A gone chunk toasts "reload"; the screen stays standing. */
export function LazyAvailability(props: { readonly overview: ModelsOverview; reloadOverview(): void }) {
  const text = useLazyFailureText();
  const { Lazy, attempt } = useRetryableLazy(loadSection);
  return (
    <LazyBoundary resetKey={attempt} onError={(error) => notifyLazyFailure(error, text)}>
      <Lazy {...props} />
    </LazyBoundary>
  );
}
