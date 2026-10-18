import { Button } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import "../../../i18n/register-model-picker.ts";
import { plural, useLocale, useT } from "../../../i18n/index.ts";
import { busy, readExtensions, type ExtensionRead } from "../extension-read.ts";
import { codeText } from "../failure.ts";
import type { ExtensionView } from "./extension-models.vm.ts";
import { useFocusSearch } from "./ModelList.tsx";

interface Props {
  readonly read: ExtensionRead;
  readonly view: ExtensionView | null;
}

/**
 * Under the model list: the click that reads the owner's global extensions (the consent of Settings' "Read providers
 * added by extensions": nothing runs before it), then what the read found. One polite live region carries the busy
 * state and the counts; a failure is an alert. The focus goes back to the search box, where the arrows reach the rows.
 */
export function ExtensionControls({ read, view }: Props) {
  const t = useT();
  const locale = useLocale();
  const focusSearch = useFocusSearch();
  const start = () => {
    readExtensions();
    focusSearch();
  };
  // The reason replaces the button the owner just pressed: a live region says it (review M9).
  if (read.status === "failed" && read.code === "forbidden")
    return (
      <p data-extension-controls role="status" className="px-s2 text-ui text-muted">
        {t("modelPicker.extensions.forbidden")}
      </p>
    );
  const running = busy(read);
  const lines: string[] = [];
  // A read again started elsewhere (a Settings write) is a read too: busy line, no button that would do nothing (M8).
  if (running) lines.push(t("modelPicker.extensions.reading"));
  if (view && !view.failed) {
    if (view.total === 0) lines.push(t("modelPicker.extensions.empty"));
    if (view.models.length > 0)
      lines.push(plural(locale, "modelPicker.extensions.count", view.models.length));
    if (view.unoffered > 0) lines.push(plural(locale, "modelPicker.extensions.unoffered", view.unoffered));
    if (view.truncated) lines.push(t("modelPicker.extensions.truncated"));
  }
  const failure =
    read.status === "failed"
      ? read.stale
        ? t("modelPicker.reload")
        : codeText(read.code)
      : view?.failed
        ? t("modelPicker.extensions.failed")
        : read.status === "ready" && read.refreshFailed !== null
          ? t("modelPicker.extensions.refreshFailed", { reason: codeText(read.refreshFailed) })
          : null;
  const label =
    read.status === "idle"
      ? t("modelPicker.extensions.show")
      : read.status === "failed" && !read.stale
        ? t("modelPicker.retry")
        : t("modelPicker.extensions.again");
  return (
    <div data-extension-controls className="flex flex-col items-start gap-s1 px-s2">
      <div role="status" className="flex flex-col gap-s1 text-ui text-muted">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {view && !view.failed && view.unoffered > 0 ? (
        <p data-extension-settings className="text-ui">
          <Link
            to="/settings/$section"
            params={{ section: "models" }}
            className="text-fg underline focus-ring"
          >
            {t("modelPicker.extensions.settings")}
          </Link>
        </p>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="text-ui text-attn">
          {failure}
        </p>
      )}
      {running || (read.status === "failed" && read.stale) ? null : (
        <>
          <Button variant="secondary" onClick={start}>
            {label}
          </Button>
          <p className="text-ui text-muted">{t("modelPicker.extensions.note")}</p>
        </>
      )}
    </div>
  );
}
