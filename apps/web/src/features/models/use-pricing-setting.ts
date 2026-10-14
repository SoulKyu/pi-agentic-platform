import { ModelsSettings } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureCode, failureText } from "./failure.ts";

export interface PricingSetting {
  /** True only when the stored `models` setting says so; a missing, malformed or unreadable one is off (M7R138). */
  readonly on: boolean;
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly notice: string | null;
  set(next: boolean): void;
  /** Reads the setting again (a `forbidden` from the lookup means it was switched off elsewhere). */
  reload(): void;
}

/**
 * The owner's `models` account setting (`modelsDevPricing`) through `settings.get` / `settings.set` with the revision
 * it read (compare-and-set). Fails closed: anything but a stored `true` reads as off.
 */
export function usePricingSetting(): PricingSetting {
  const [state, setState] = useState({ on: false, revision: 0, loaded: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("settings.get", { key: "models" })
      .then(
        (answer) => {
          if (!current) return;
          const parsed = ModelsSettings.safeParse(answer.value ?? {});
          setState({
            on: parsed.success && parsed.data.modelsDevPricing,
            revision: typeof answer.revision === "number" ? answer.revision : 0,
            loaded: true,
          });
        },
        (failure: unknown) => {
          if (!current) return;
          setState((previous) => ({ ...previous, on: false, loaded: true }));
          setNotice(failureText(failure));
        },
      );
    return () => {
      current = false;
    };
  }, [loads]);

  const reload = useCallback(() => setLoads((count) => count + 1), []);

  const set = useCallback(
    (next: boolean) => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      const rpc = getRuntime().rpc;
      rpc
        .call(
          "settings.set",
          { key: "models", value: { modelsDevPricing: next }, baseRevision: state.revision },
          { commandId: rpc.newCommandId() },
        )
        .then(
          (answer) => setState({ on: next, revision: answer.revision, loaded: true }),
          (failure: unknown) => {
            if (failureCode(failure) === "conflict") {
              setNotice(t("settingsModels.pricing.conflict"));
              reload();
            } else {
              setNotice(failureText(failure));
            }
          },
        )
        .finally(() => setBusy(false));
    },
    [busy, state.revision, reload],
  );

  return { on: state.on, loaded: state.loaded, busy, notice, set, reload };
}
