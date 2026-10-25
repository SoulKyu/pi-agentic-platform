import { PROVIDER_FORM_LIMITS } from "@pap/contracts";
import type { ModelsDiscoverResult } from "@pap/contracts";
import { Button, Checkbox, Heading, InlineError } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { stripHidden } from "../../../lib/untrusted-text.ts";
import { getRuntime } from "../../../runtime/index.ts";
import { failureText } from "../failure.ts";
import { providerCodeText } from "../models-json.vm.ts";
import type { StepUpRunner } from "../step-up.ts";
import type { ModelDraft } from "./provider-form.vm.ts";

/** Rows drawn at first; a gateway with hundreds shows the rest on request. */
const SHOWN = 100;
type Found = ModelsDiscoverResult["models"];

/**
 * Asks the saved provider which models it offers (step-up: the request carries its key) and fills the ticked ones into
 * the form's rows. It saves nothing: the owner presses Save (MPR15, MPR20). At most 500 models fit in a provider, so
 * once that many are ticked the other rows are disabled.
 */
export function DiscoverImport({
  provider,
  models,
  stepUp,
  onImport,
}: {
  /** The saved provider's id; null while the form has not saved one yet. */
  readonly provider: string | null;
  readonly models: readonly ModelDraft[];
  readonly stepUp: StepUpRunner;
  onImport(added: readonly ModelDraft[]): void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(SHOWN);
  const [notice, setNotice] = useState<{ tone: "error" | "status"; text: string } | null>(null);

  const listed = new Set(models.map((model) => model.id.trim()));
  const room = Math.max(0, PROVIDER_FORM_LIMITS.models - models.length);
  const free = (found ?? []).filter((one) => !listed.has(one.id));
  const full = ticked.size >= room;

  const discover = () => {
    if (busy || provider === null) return;
    setBusy(true);
    setNotice(null);
    stepUp((commandId) => getRuntime().rpc.call("models.discover", { provider }, { commandId }))
      .then(
        (result) => {
          if (result === null) return;
          setTicked(new Set());
          setShown(SHOWN);
          if (result.code !== undefined) {
            setFound(null);
            setNotice({
              tone: "error",
              text: providerCodeText(result.code, "settingsProviders.discover.failed"),
            });
            return;
          }
          // Ids are untrusted text: stripped once here, so the row, the key and the imported id are the same string.
          const seen = new Set<string>();
          setFound(
            result.models
              .map((one) => ({ ...one, id: stripHidden(one.id) }))
              .filter((one) => one.id !== "" && !seen.has(one.id) && seen.add(one.id)),
          );
          setTruncated(result.truncated === true);
        },
        (failure: unknown) => setNotice({ tone: "error", text: failureText(failure) }),
      )
      .finally(() => setBusy(false));
  };

  const toggle = (id: string, on: boolean) =>
    setTicked((previous) => {
      const next = new Set(previous);
      if (on && next.size < room) next.add(id);
      else if (!on) next.delete(id);
      return next;
    });

  const add = () => {
    const chosen = free.filter((one) => ticked.has(one.id));
    onImport(
      chosen.map((one) => ({
        id: one.id,
        name: "",
        reasoning: one.reasoning === true,
        image: false,
        contextWindow: one.contextWindow === undefined ? "" : String(one.contextWindow),
        maxTokens: one.maxTokens === undefined ? "" : String(one.maxTokens),
      })),
    );
    setTicked(new Set());
    setNotice({ tone: "status", text: t("settingsProviders.discover.added", { count: chosen.length }) });
  };

  return (
    <section aria-label={t("settingsProviders.discover.title")} className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("settingsProviders.discover.title")}
      </Heading>
      <div>
        <Button disabled={busy || provider === null} onClick={discover}>
          {t("settingsProviders.discover.button")}
        </Button>
      </div>
      {provider === null ? (
        <p className="text-ui text-muted">{t("settingsProviders.discover.needsSave")}</p>
      ) : null}
      {found !== null && found.length === 0 ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsProviders.discover.none")}
        </p>
      ) : null}
      {found !== null && found.length > 0 ? (
        <div className="flex flex-col gap-s2">
          <p className="text-ui text-fg">{t("settingsProviders.discover.found", { count: found.length })}</p>
          {free.length > room ? (
            <p className="text-ui text-muted">{t("settingsProviders.discover.cap", { room })}</p>
          ) : null}
          {truncated ? <p className="text-ui text-muted">{t("settingsProviders.discover.cut")}</p> : null}
          <div>
            <Button
              disabled={room === 0 || free.length === 0}
              onClick={() => setTicked(new Set(free.slice(0, room).map((one) => one.id)))}
            >
              {t("settingsProviders.discover.tickAll")}
            </Button>
          </div>
          <ul className="flex flex-col gap-s1">
            {found.slice(0, shown).map((one) => {
              const there = listed.has(one.id);
              const on = ticked.has(one.id);
              return (
                <li key={one.id} data-discovered={one.id}>
                  <Checkbox
                    label={there ? `${one.id} (${t("settingsProviders.discover.listed")})` : one.id}
                    checked={on}
                    disabled={there || (!on && full)}
                    onChange={(next) => toggle(one.id, next)}
                  />
                </li>
              );
            })}
          </ul>
          {found.length > shown ? (
            <div>
              <Button onClick={() => setShown(shown + SHOWN)}>
                {t("settingsProviders.discover.more", { count: Math.min(SHOWN, found.length - shown) })}
              </Button>
            </div>
          ) : null}
          <div>
            <Button variant="primary" disabled={ticked.size === 0} onClick={add}>
              {t("settingsProviders.discover.add", { count: ticked.size })}
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? (
        notice.tone === "error" ? (
          <InlineError announce="action">{notice.text}</InlineError>
        ) : (
          <p role="status" className="text-ui text-muted">
            {notice.text}
          </p>
        )
      ) : null}
    </section>
  );
}
