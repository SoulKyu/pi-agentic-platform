import { Banner, Button, Icon, IconExport, Markdown, Segmented, LoadingLine, InlineError } from "@pap/ui";
import { CodeEditor, languageFor } from "@pap/ui/code";
import { useState } from "react";
import { useT, type Translate } from "../../i18n/index.ts";
import "../../i18n/register-launch.ts";
import { useBoxCauseText } from "../../stores/loading-cause.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { baseName, formatSize, rawUrl, viewKind, VIEW_LIMIT_BYTES } from "./files.vm.ts";
import { EditorBar } from "./EditorBar.tsx";
import { useBuffers, type Buffers } from "./use-buffers.ts";
import { useOpenFile } from "./use-open-file.ts";
import { NO_STEP_UP, useSave, type StepUp } from "./use-save.ts";

const LINK_CLASSES =
  "inline-flex items-center gap-s1 text-agent underline underline-offset-2 focus-ring pointer-coarse:min-h-11";

/** CodeMirror's own phrases, in the page's language. */
function editorPhrases(t: Translate): Record<string, string> {
  return {
    Find: t("files.cm.find"),
    next: t("files.cm.next"),
    previous: t("files.cm.previous"),
    all: t("files.cm.all"),
    "match case": t("files.cm.matchCase"),
    regexp: t("files.cm.regexp"),
    "by word": t("files.cm.byWord"),
    close: t("files.cm.close"),
    "Go to line": t("files.cm.goToLine"),
    go: t("files.cm.go"),
  };
}

function DownloadLink({ path }: { readonly path: string }) {
  const t = useT();
  return (
    <a href={rawUrl(path, true)} download className={LINK_CLASSES}>
      <Icon icon={IconExport} size={14} />
      {t("files.viewer.download")}
    </a>
  );
}

interface FileViewerProps {
  readonly path: string;
  readonly panelId?: string;
  readonly tabId?: string;
  /** The unsaved edits and view modes of the open tabs, kept by the pane; a viewer on its own keeps its own. */
  readonly buffers?: Buffers;
  readonly stepUp?: StepUp;
}

/** One file: code in the editor (editable when the whole file is loaded and may be edited), Markdown as a preview or its source, an image through the sandboxed raw route. */
export function FileViewer({ path, panelId, tabId, buffers, stepUp }: FileViewerProps) {
  const t = useT();
  const cause = useBoxCauseText(t, path);
  const file = useOpenFile(path);
  const own = useBuffers();
  const held = buffers ?? own;
  const buffer = held.byPath.get(path);
  const mode = held.modes.get(path) ?? "preview";
  const save = useSave({ path, file, buffer, stepUp: stepUp ?? NO_STEP_UP, drop: held.drop });
  const [imageFailed, setImageFailed] = useState(false);
  const { meta } = file;

  let body;
  if (file.status === "loading") {
    body = (
      <div className="p-s3">
        <LoadingLine label={t("files.viewer.loading")} cause={cause} />
      </div>
    );
  } else if (file.status === "error" || meta === null) {
    body = (
      <div className="p-s3">
        <Banner
          tone="capacity"
          title={file.code === "not_found" ? t("files.viewer.gone") : t("files.viewer.failed")}
          actions={
            <Button variant="secondary" size="sm" onClick={file.reload}>
              {t("files.viewer.retry")}
            </Button>
          }
        />
      </div>
    );
  } else {
    const kind = viewKind(path, meta);
    const capped = file.nextOffset !== null && file.nextOffset >= VIEW_LIMIT_BYTES;
    const text = buffer?.draft ?? file.text;
    const editable = meta.editable && file.complete && (kind === "text" || kind === "markdown");
    const editor = (
      <CodeEditor
        value={text}
        readOnly={!editable || save.state.kind === "saving"}
        onChange={(draft) => held.edit(path, { etag: meta.etag, text: file.text }, draft)}
        onSave={save.save}
        language={languageFor(path)}
        labels={{ label: t("files.viewer.editorLabel"), phrases: editorPhrases(t) }}
        onLoadError={() => reportClientIssue("lazy_chunk_failed")}
      />
    );
    body = (
      <>
        <div className="flex flex-wrap items-center justify-between gap-s2 border-b border-border px-s3 py-s1">
          <span data-slot="file-name" className="min-w-0 truncate font-mono text-code text-muted">
            {baseName(path)}
          </span>
          <div className="flex items-center gap-s3">
            {kind === "markdown" ? (
              <Segmented<"preview" | "source">
                label={t("files.viewer.mode")}
                labelHidden
                value={mode}
                options={[
                  { value: "preview", label: t("files.viewer.preview") },
                  { value: "source", label: t("files.viewer.source") },
                ]}
                onChange={(next) => held.setMode(path, next)}
              />
            ) : null}
            <DownloadLink path={path} />
          </div>
        </div>
        {editable ? (
          <EditorBar save={save} dirty={buffer !== undefined} protection={meta.protection} />
        ) : null}
        {file.note === null ? null : (
          <p role="status" className="border-b border-border px-s3 py-s1 text-ui text-muted">
            {t(file.note === "changed" ? "files.viewer.changed" : "files.viewer.unstable")}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {kind === "binary" ? (
            <p className="p-s3 text-ui text-muted">
              {t("files.viewer.binary", { size: formatSize(meta.size) })}
            </p>
          ) : kind === "image" ? (
            <div className="flex flex-col items-start gap-s2 p-s3">
              {imageFailed ? (
                <p className="text-ui text-muted">{t("files.viewer.imageFailed")}</p>
              ) : (
                <img
                  src={rawUrl(path)}
                  alt={baseName(path)}
                  onError={() => setImageFailed(true)}
                  className="max-h-full max-w-full object-contain"
                />
              )}
            </div>
          ) : kind === "markdown" && mode === "preview" ? (
            <div className="p-s3">
              <Markdown text={text} onLoadError={() => reportClientIssue("lazy_chunk_failed")} />
            </div>
          ) : (
            editor
          )}
        </div>
        {kind === "text" || kind === "markdown" ? (
          <div className="flex flex-wrap items-center gap-s2 border-t border-border px-s3 py-s1 text-ui text-muted">
            {capped ? (
              <p role="status">{t("files.viewer.tooLarge")}</p>
            ) : file.nextOffset !== null ? (
              <Button variant="secondary" size="sm" onClick={file.loadMore} disabled={file.loadingMore}>
                {t("files.viewer.more")}
              </Button>
            ) : null}
            {file.moreFailed ? (
              <InlineError announce="action">{t("files.viewer.moreFailed")}</InlineError>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }
  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      aria-label={tabId === undefined ? t("files.viewer.label") : undefined}
      data-slot="file-viewer"
      data-complete={file.complete ? "true" : "false"}
      className="flex min-h-0 flex-1 flex-col"
    >
      {body}
    </div>
  );
}
