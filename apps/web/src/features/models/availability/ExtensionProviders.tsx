import type { ProviderView } from "@pap/contracts";
import { Button, Heading, InlineError } from "@pap/ui";
import { useT } from "../../../i18n/index.ts";
import { readExtensions, useExtensionRead } from "../extension-read.ts";
import { codeText } from "../failure.ts";
import { extensionRows } from "./availability.vm.ts";
import { ExtensionRowItem, type ExtensionSelection } from "./ExtensionRowItem.tsx";

/**
 * The providers the owner's global extensions register, read on a click (MPR17), each model with the switch the other
 * providers have: "My selection" can name them (`models.setEnabled`, the same ops). The answer is the tab's
 * (`extension-read.ts`), shared with the model pickers: reopening this view or a picker runs nothing again, "Read again"
 * does, and so does a selection write. A press while a read runs joins it. Nothing here claims the load is offline:
 * Pi's offline flag stops Pi's own installs and refresh, not an extension's own fetch (MPR-C8).
 */
export function ExtensionProviders({
  providers,
  providersTruncated,
  selection,
}: {
  readonly providers: readonly ProviderView[];
  /** The overview cut its provider list: a provider of models.json may be missing from `providers`. */
  readonly providersTruncated: boolean;
  readonly selection: ExtensionSelection;
}) {
  const t = useT();
  const state = useExtensionRead();
  const rows = state.status === "ready" ? extensionRows(state.answer, providers) : [];
  const busy = state.status === "reading" || (state.status === "ready" && state.refreshing);
  return (
    <section data-extensions className="flex flex-col items-start gap-s2">
      <Heading level={3} variant="group">
        {t("settingsAvailability.extensions.title")}
      </Heading>
      <p className="text-ui text-muted">{t("settingsAvailability.extensions.note")}</p>
      <Button disabled={busy} onClick={readExtensions}>
        {state.status === "idle"
          ? t("settingsAvailability.extensions.read")
          : t("settingsAvailability.extensions.again")}
      </Button>
      {state.status === "reading" ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsAvailability.extensions.reading")}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <InlineError announce="background">
          {state.stale ? t("settingsAvailability.reload") : codeText(state.code)}
        </InlineError>
      ) : null}
      {state.status === "ready" && state.refreshing ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsAvailability.extensions.reading")}
        </p>
      ) : null}
      {state.status === "ready" ? (
        <>
          {state.refreshFailed === null ? null : (
            <InlineError announce="action">
              {t("settingsAvailability.extensions.refreshFailed", { reason: codeText(state.refreshFailed) })}
            </InlineError>
          )}
          {state.answer.failed ? (
            <InlineError announce="action">{t("settingsAvailability.extensions.failed")}</InlineError>
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
              <ExtensionRowItem key={`${index}:${row.provider}`} row={row} selection={selection} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
