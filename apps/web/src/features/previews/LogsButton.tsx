import "../../i18n/register-previews.ts";
import type { BoxRef } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";

const loadLogs = () =>
  import("./PreviewLogsDialog.tsx").then((module) => ({ default: module.PreviewLogsDialog }));

/** LOGS: the dialog is its own chunk, fetched on the first click (UX2-R44). */
export function LogsButton({ box, name }: { readonly box: BoxRef; readonly name: string }) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {t("previews.logs")}
      </Button>
      <LazyPanel
        text={lazyText}
        load={loadLogs}
        open={open}
        props={{ box, name, onClose: close }}
        onFailed={close}
      />
    </>
  );
}
