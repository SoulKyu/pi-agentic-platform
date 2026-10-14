import type { ModelsDiscoverResult, ProviderView } from "@pap/contracts";
import { Button, Checkbox } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";
import { discoverSupported, insertModels, providerCodeText } from "./models-json.vm.ts";
import type { StepUpRunner } from "./step-up.ts";

/** Found models drawn at first; a gateway with hundreds shows the rest on request. */
const SHOWN = 100;

type Found = ModelsDiscoverResult["models"];

/**
 * Asks the provider which models it offers (behind the password step-up: the request carries the provider's key) and
 * adds the ticked ones to the editor's draft as JSON the owner reads before saving. Discovery saves nothing.
 */
export function DiscoverPanel({
  provider,
  stepUp,
  draft,
  onDraft,
}: {
  readonly provider: ProviderView;
  readonly stepUp: StepUpRunner;
  readonly draft: string;
  onDraft(text: string): void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(SHOWN);
  const [notice, setNotice] = useState<{ tone: "error" | "status"; text: string } | null>(null);
  if (!discoverSupported(provider)) return null;

  const discover = () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const rpc = getRuntime().rpc;
    stepUp((commandId) => rpc.call("models.discover", { provider: provider.id }, { commandId }))
      .then(
        (result) => {
          if (result === null) return;
          setTicked(new Set());
          setShown(SHOWN);
          if (result.code !== undefined) {
            setFound(null);
            setNotice({
              tone: "error",
              text: providerCodeText(result.code, "settingsModels.discover.failed"),
            });
            return;
          }
          setFound(result.models);
          setTruncated(result.truncated === true);
        },
        (failure: unknown) => setNotice({ tone: "error", text: failureText(failure) }),
      )
      .finally(() => setBusy(false));
  };

  const toggle = (id: string, on: boolean) =>
    setTicked((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const add = () => {
    const chosen = (found ?? []).filter((one) => ticked.has(one.id));
    const result = insertModels(draft, provider.id, chosen);
    if (result === null) {
      setNotice({ tone: "error", text: t("settingsModels.discover.cannot") });
      return;
    }
    onDraft(result.text);
    setTicked(new Set());
    setNotice({
      tone: "status",
      text: t("settingsModels.discover.added", { added: result.added, skipped: result.skipped }),
    });
  };

  return (
    <section aria-label={t("settingsModels.discover.button")} className="flex flex-col gap-s2">
      <div>
        <Button disabled={busy} onClick={discover}>
          {t("settingsModels.discover.button")}
        </Button>
      </div>
      {found !== null && found.length === 0 ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsModels.discover.none")}
        </p>
      ) : null}
      {found !== null && found.length > 0 ? (
        <div className="flex flex-col gap-s2">
          <p className="text-ui text-fg">{t("settingsModels.discover.found", { count: found.length })}</p>
          <p className="text-ui text-muted">{t("settingsModels.discover.review")}</p>
          {truncated ? <p className="text-ui text-muted">{t("settingsModels.discover.cut")}</p> : null}
          <ul className="flex flex-col gap-s1">
            {found.slice(0, shown).map((one) => (
              <li key={one.id}>
                <Checkbox label={one.id} checked={ticked.has(one.id)} onChange={(on) => toggle(one.id, on)} />
              </li>
            ))}
          </ul>
          {found.length > shown ? (
            <div>
              <Button onClick={() => setShown(shown + SHOWN)}>
                {t("settingsModels.discover.more", { count: Math.min(SHOWN, found.length - shown) })}
              </Button>
            </div>
          ) : null}
          <div>
            <Button variant="primary" disabled={ticked.size === 0} onClick={add}>
              {t("settingsModels.discover.add", { count: ticked.size })}
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={notice.tone === "error" ? "text-ui text-attn" : "text-ui text-muted"}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
