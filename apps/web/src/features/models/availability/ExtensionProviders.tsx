import type { ExtensionProviders as Answer, ProviderView } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { reportClientIssue } from "../../../lib/report.ts";
import { getRuntime } from "../../../runtime/index.ts";
import { failureCode, failureText } from "../failure.ts";
import { isStale } from "../picker/use-available-models.ts";
import { extensionRows } from "./availability.vm.ts";

type State =
  | { readonly status: "idle" }
  | { readonly status: "reading" }
  | { readonly status: "failed"; readonly text: string; readonly stale: boolean }
  | { readonly status: "ready"; readonly answer: Answer };

/**
 * The providers the owner's global extensions register, read on a click (MPR17) and shown read-only: they appear in a
 * session's model menu only. An answer for a gone view is dropped; a second press while one read runs does nothing.
 * Nothing here claims the load is offline: Pi's offline flag stops Pi's own installs and refresh, not an extension's
 * own fetch (MPR-C8).
 */
export function ExtensionProviders({
  providers,
  providersTruncated,
}: {
  readonly providers: readonly ProviderView[];
  /** The overview cut its provider list: a provider of models.json may be missing from `providers`. */
  readonly providersTruncated: boolean;
}) {
  const t = useT();
  const [state, setState] = useState<State>({ status: "idle" });
  const alive = useRef(true);
  const reading = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = () => {
    if (reading.current) return;
    reading.current = true;
    setState({ status: "reading" });
    getRuntime()
      .rpc.call("models.extensions", {})
      .then(
        (answer) => {
          if (alive.current) setState({ status: "ready", answer });
        },
        (error: unknown) => {
          reportClientIssue("setting_load_failed");
          if (alive.current)
            setState({
              status: "failed",
              text: failureCode(error) === "unknown_method" ? "" : failureText(error),
              stale: isStale(error),
            });
        },
      )
      .finally(() => {
        reading.current = false;
      });
  };

  const rows = state.status === "ready" ? extensionRows(state.answer, providers) : [];
  return (
    <section data-extensions className="flex flex-col items-start gap-s2">
      <h3 className="label-hud text-muted">{t("settingsAvailability.extensions.title")}</h3>
      <p className="text-ui text-muted">{t("settingsAvailability.extensions.note")}</p>
      <Button disabled={state.status === "reading"} onClick={read}>
        {t("settingsAvailability.extensions.read")}
      </Button>
      {state.status === "reading" ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsAvailability.extensions.reading")}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <p role="alert" className="text-ui text-attn">
          {state.stale ? t("settingsAvailability.reload") : state.text}
        </p>
      ) : null}
      {state.status === "ready" ? (
        <>
          {state.answer.failed ? (
            <p role="alert" className="text-ui text-attn">
              {t("settingsAvailability.extensions.failed")}
            </p>
          ) : null}
          {state.answer.truncated ? (
            <p className="text-ui text-muted">{t("settingsAvailability.extensions.truncated")}</p>
          ) : null}
          {providersTruncated ? (
            <p className="text-ui text-muted">{t("settingsAvailability.extensions.overridesUnknown")}</p>
          ) : null}
          {rows.length === 0 && !state.answer.failed ? (
            <p className="text-ui text-muted">{t("settingsAvailability.extensions.empty")}</p>
          ) : null}
          <ul className="flex w-full flex-col gap-s3">
            {rows.map((row, index) => (
              <li
                key={`${index}:${row.id}`}
                data-extension-provider={row.id}
                data-overrides={row.overrides ? "true" : "false"}
                className="flex flex-col gap-s1"
              >
                <div className="flex flex-wrap items-center gap-s2">
                  <span className="text-ui text-fg">{row.name === "" ? row.id : row.name}</span>
                  {row.overrides ? (
                    <Chip tone="att" label={t("settingsAvailability.extensions.overrides")} />
                  ) : null}
                </div>
                {row.overrides ? (
                  <p className="text-ui text-muted">{t("settingsAvailability.extensions.overridesNote")}</p>
                ) : null}
                {row.models.length === 0 ? (
                  <p className="text-ui text-muted">{t("settingsAvailability.extensions.noModels")}</p>
                ) : (
                  <ul className="flex flex-col gap-s1 pl-s4 text-ui text-muted">
                    {row.models.map((model, at) => (
                      <li key={`${at}:${model.id}`} data-extension-model={model.id}>
                        {model.label}
                      </li>
                    ))}
                  </ul>
                )}
                {row.modelsTruncated ? (
                  <p className="text-ui text-muted">{t("settingsAvailability.extensions.modelsTruncated")}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
