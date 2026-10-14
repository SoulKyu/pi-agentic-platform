import { Button } from "@pap/ui";
import { useT } from "../../../i18n/index.ts";
import { formatBytes } from "./drop.ts";
import "./register-files-catalog.ts";
import type { Attachments } from "./use-attachments.ts";

/** One chip per file: a local thumbnail for a picture, its name and size, and what is happening to it. */
export function AttachmentTray({ attachments }: { readonly attachments: Attachments }) {
  const t = useT();
  const { items, note, dragging } = attachments;
  if (items.length === 0 && !note && !dragging) return null;
  return (
    <div data-attachment-tray className="flex flex-col gap-s1">
      {dragging ? <p className="label-hud text-agent">{t("sessions.files.drop")}</p> : null}
      {note ? (
        <p role="status" aria-live="polite" className="text-ui text-muted">
          {note}
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul aria-label={t("sessions.files.tray")} className="flex flex-wrap gap-s2">
          {items.map((item) => (
            <li
              key={item.key}
              className="flex max-w-full items-center gap-s2 rounded-sm border border-control-border bg-surface px-s2 py-s1"
            >
              {item.previewUrl ? (
                <img src={item.previewUrl} alt="" className="size-8 shrink-0 rounded-sm object-cover" />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-ui text-fg">{item.name}</span>
              <span className="text-ui text-muted">{formatBytes(item.size)}</span>
              {item.status === "queued" || item.status === "uploading" ? (
                <span className="text-ui text-muted">{t("sessions.files.uploading")}</span>
              ) : null}
              {item.asFile ? (
                <span className="text-ui text-muted">{t("sessions.files.sentAsFile")}</span>
              ) : null}
              {item.error ? (
                <>
                  <span role="alert" className="text-ui text-attn">
                    {item.error}
                  </span>
                  <Button
                    size="sm"
                    aria-label={t("sessions.files.retry", { name: item.name })}
                    onClick={() => attachments.retry(item.key)}
                  >
                    {t("sessions.files.retryLabel")}
                  </Button>
                </>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("sessions.files.remove", { name: item.name })}
                onClick={() => attachments.remove(item.key)}
              >
                {t("sessions.files.removeLabel")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
