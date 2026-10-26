import type { AvailableModelsData } from "@pap/contracts";
import { usePendingAction, usePendingFeedback, InlineError } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { StarButton } from "../models/StarButton.tsx";
import ModelList from "../models/picker/ModelList.tsx";
import { modelKey, toPickerModel, type PickerModel } from "../models/picker/model-picker.vm.ts";
import type { AvailableState } from "../models/picker/use-available-models.ts";
import { failureText } from "./failure.ts";
import { defaultFailureText } from "./model-menu.vm.ts";

interface ModelMenuProps {
  readonly sessionId: string;
  readonly current: { readonly provider: string; readonly id: string } | null;
  onClose(): void;
}

type Listing =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "ready"; readonly data: AvailableModelsData };

interface Defaults {
  readonly provider: string | null;
  readonly model: string | null;
}

/** The stage label of a switch that is taking long (DESIGN §7.3): shown beside the row once the wait passes 3 s. */
function StageLabel({ since, label }: { readonly since: number | null; readonly label: string }) {
  return usePendingFeedback(since, { remote: false }) === "stage" ? (
    <span className="px-s2 text-ui text-muted">{label}</span>
  ) : null;
}

/**
 * The model menu (M7R51, R52, R53): the session's own models, in the shared picker list (search, groups by provider in
 * the list's order), the current row marked and a star that sets the default. Fetched when it opens; a cold session's
 * worker starts for it only outside a VM; in a VM the menu comes from the settings at once.
 */
export default function ModelMenu({ sessionId, current, onClose }: ModelMenuProps) {
  const t = useT();
  const runtime = getRuntime();
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [defaultsUnknown, setDefaultsUnknown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [starring, setStarring] = useState(false);
  const pick = usePendingAction();

  useEffect(() => {
    let live = true;
    runtime.rpc.call("sessions.models", { sessionId }).then(
      (data) => live && setListing({ state: "ready", data }),
      (failure: unknown) => live && setListing({ state: "failed", message: failureText(failure) }),
    );
    return () => {
      live = false;
    };
  }, [runtime, sessionId, attempt]);

  // The defaults are read once, when the menu opens; without them the stars are simply unmarked, and the menu says so.
  useEffect(() => {
    let live = true;
    runtime.rpc.call("models.overview", {}).then(
      (overview) => live && setDefaults(overview.defaults),
      () => live && setDefaultsUnknown(true),
    );
    return () => {
      live = false;
    };
  }, [runtime]);

  const choose = async (model: PickerModel) => {
    const marked = current ?? data?.current ?? null;
    if (marked?.provider === model.provider && marked.id === model.id) return onClose();
    setError(null);
    setNotice(null);
    setPicking(modelKey(model));
    const done = await pick.run(async () => {
      try {
        await runtime.rpc.call(
          "sessions.setModel",
          { sessionId, provider: model.provider, modelId: model.id },
          { commandId: runtime.rpc.newCommandId() },
        );
        return true;
      } catch (failure) {
        setError(failureText(failure));
        return false;
      }
    });
    setPicking(null);
    if (done) onClose();
  };

  const makeDefault = async (model: PickerModel) => {
    setStarring(true);
    setError(null);
    setNotice(null);
    const saved = await runtime.rpc
      .call(
        "models.setDefault",
        { provider: model.provider, modelId: model.id },
        { commandId: runtime.rpc.newCommandId() },
      )
      .then(
        () => true,
        (failure: unknown) => {
          setError(defaultFailureText(failure));
          return false;
        },
      );
    if (saved) {
      setDefaults({ provider: model.provider, model: model.id });
      setNotice(t("sessionModels.menu.defaultSaved"));
    }
    setStarring(false);
  };

  const data = listing.state === "ready" ? listing.data : null;
  const marked = current ?? data?.current ?? null;
  const state = useMemo<AvailableState>(() => {
    if (listing.state === "loading") return { status: "loading" };
    if (listing.state === "failed")
      return {
        status: "failed",
        stale: false,
        message: listing.message,
        reload: () => {
          setListing({ state: "loading" });
          setAttempt((n) => n + 1);
        },
      };
    return {
      status: "ready",
      models: listing.data.models.map(toPickerModel),
      labels: new Map(),
      origin: "session",
      truncated: listing.data.truncated,
    };
  }, [listing]);
  const rowEnd = (model: PickerModel) => {
    const label = model.name === "" ? model.id : model.name;
    const isDefault =
      defaults !== null && defaults.provider === model.provider && defaults.model === model.id;
    const isCurrent = marked !== null && marked.provider === model.provider && marked.id === model.id;
    return (
      <>
        {picking === modelKey(model) ? (
          <StageLabel since={pick.since} label={t("sessionModels.menu.starting")} />
        ) : null}
        {isCurrent ? (
          <span className="px-s2 text-ui text-muted">{t("sessionModels.menu.current")}</span>
        ) : null}
        <StarButton
          label={t("sessionModels.menu.setDefault", { model: label })}
          isDefault={isDefault}
          disabled={starring}
          onPress={() => void makeDefault(model)}
        />
      </>
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("sessionModels.menu.title")}
      closeLabel={t("sessionModels.menu.close")}
    >
      <div data-model-menu className="flex min-h-0 flex-1 flex-col gap-s2 p-s3">
        <ModelList
          state={state}
          value={marked ? { provider: marked.provider, modelId: marked.id } : null}
          disabled={pick.since !== null}
          renderRowEnd={rowEnd}
          onPick={(model) => void choose(model)}
        />
        {defaultsUnknown ? (
          <p className="text-ui text-muted">{t("sessionModels.menu.defaultsUnknown")}</p>
        ) : null}
        {notice ? (
          <p role="status" className="text-ui text-muted">
            {notice}
          </p>
        ) : null}
        {error ? <InlineError announce="action">{error}</InlineError> : null}
      </div>
    </Dialog>
  );
}
