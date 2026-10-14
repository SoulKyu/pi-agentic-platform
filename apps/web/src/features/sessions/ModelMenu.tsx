import type { AvailableModelsData, ModelSummary } from "@pap/contracts";
import { Button, TextField, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";
import { defaultFailureText, groupModels } from "./model-menu.vm.ts";

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

const rowKey = (model: ModelSummary): string => `${model.provider}/${model.id}`;

/**
 * The model menu (M7R51, R52, R53): the session's own models grouped by provider in the list's order, a search field,
 * the current row marked and a star that sets the default. Fetched when it opens; a cold session's worker starts for it.
 */
export default function ModelMenu({ sessionId, current, onClose }: ModelMenuProps) {
  const t = useT();
  const runtime = getRuntime();
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [defaultsUnknown, setDefaultsUnknown] = useState(false);
  const [query, setQuery] = useState("");
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

  const choose = async (model: ModelSummary) => {
    const marked = current ?? data?.current ?? null;
    if (marked?.provider === model.provider && marked.id === model.id) return onClose();
    setError(null);
    setNotice(null);
    setPicking(rowKey(model));
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

  const makeDefault = async (model: ModelSummary) => {
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
  const groups = data ? groupModels(data.models, query, current ?? data.current, defaults) : [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("sessionModels.menu.title")}
      closeLabel={t("sessionModels.menu.close")}
    >
      <div data-model-menu className="flex flex-col gap-s2 p-s3">
        <TextField
          label={t("sessionModels.menu.search")}
          value={query}
          onChange={setQuery}
          name="model-search"
          autoComplete="off"
        />
        {listing.state === "loading" ? (
          <p role="status" className="text-ui text-muted">
            {t("sessionModels.menu.loading")}
          </p>
        ) : null}
        {listing.state === "failed" ? (
          <div className="flex flex-col items-start gap-s2">
            <p role="alert" className="text-ui text-attn">
              {listing.message}
            </p>
            <Button
              onClick={() => {
                setListing({ state: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              {t("sessionModels.menu.retry")}
            </Button>
          </div>
        ) : null}
        {data && data.models.length === 0 ? (
          <p className="text-ui text-fg">
            {t("sessionModels.menu.empty")}{" "}
            <Link
              to="/settings/$section"
              params={{ section: "models" }}
              className="text-agent underline focus-ring"
            >
              {t("sessionModels.menu.signIn")}
            </Link>
          </p>
        ) : null}
        {data && data.models.length > 0 && groups.length === 0 ? (
          <p className="text-ui text-muted">{t("sessionModels.menu.noMatch")}</p>
        ) : null}
        {groups.map((group) => (
          <section
            key={group.provider}
            aria-label={group.provider}
            data-model-group={group.provider}
            className="flex flex-col gap-s1"
          >
            <h3 className="label-hud text-muted">{group.provider}</h3>
            <ul className="flex flex-col gap-s1">
              {group.rows.map((row) => {
                const key = rowKey(row.model);
                const label = row.model.name === "" ? row.model.id : row.model.name;
                return (
                  <li key={key} className="flex items-center gap-s1">
                    <Button
                      variant="ghost"
                      data-model-row={row.model.id}
                      aria-current={row.current ? "true" : undefined}
                      disabled={pick.since !== null}
                      pendingSince={picking === key ? pick.since : null}
                      remote={false}
                      stageLabel={t("sessionModels.menu.starting")}
                      onClick={() => void choose(row.model)}
                    >
                      <span className="flex-1 text-left">{label}</span>
                      {row.current ? (
                        <span className="text-muted">{t("sessionModels.menu.current")}</span>
                      ) : null}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={t("sessionModels.menu.setDefault", { model: label })}
                      aria-pressed={row.isDefault}
                      disabled={starring}
                      onClick={() => void makeDefault(row.model)}
                    >
                      <span aria-hidden="true" className={row.isDefault ? "text-agent" : "text-muted"}>
                        {row.isDefault ? "★" : "☆"}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {data?.truncated ? <p className="text-ui text-muted">{t("sessionModels.menu.truncated")}</p> : null}
        {defaultsUnknown ? (
          <p className="text-ui text-muted">{t("sessionModels.menu.defaultsUnknown")}</p>
        ) : null}
        {notice ? (
          <p role="status" className="text-ui text-muted">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-ui text-attn">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
