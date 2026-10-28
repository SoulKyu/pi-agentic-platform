import { Button, Icon, IconBack, EmptyState, useIsPhone, InlineError } from "@pap/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import "../../i18n/register-files.ts";
import { useT } from "../../i18n/index.ts";
import { Explorer } from "./Explorer.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { openTab } from "./files.vm.ts";
import { useFilesTarget } from "../../stores/files-target.ts";
import { setUnsavedFiles } from "../../stores/unsaved-files.ts";
import { useBuffers } from "./use-buffers.ts";
import { NO_STEP_UP, type StepUp } from "./use-save.ts";
import { tabIdOf, ViewerTabs } from "./ViewerTabs.tsx";

export type { StepUp };

interface FilesPaneProps {
  readonly root: string;
  /** Saves that need the password (M8R117); the shell builds it from the auth feature. */
  readonly stepUp?: StepUp;
}

/** The explorer and the viewer of one folder (M8R76). On a phone they stack: the tree, then the open file with Back. */
export function FilesPane({ root, stepUp: given }: FilesPaneProps) {
  const stepUp = given ?? NO_STEP_UP;
  const t = useT();
  const phone = useIsPhone();
  const ids = useId();
  const [tabs, setTabs] = useState<readonly string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [full, setFull] = useState(false);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const buffers = useBuffers();
  // A path opened from a reply (UX1-R12/R13): taken once the root has listed, so a stopped box shows START and waits.
  const [listedRoot, setListedRoot] = useState<string | null>(null);
  const [line, setLine] = useState<{
    readonly path: string;
    readonly n: number;
    readonly key: number;
  } | null>(null);
  const waiting = useFilesTarget((state) => state.targets[root]?.n);
  const onListed = useCallback(() => setListedRoot(root), [root]);
  const anyDirty = buffers.dirty.size > 0;

  // The shell asks before it closes this pane while edits are unsaved.
  useEffect(() => {
    setUnsavedFiles(root, anyDirty);
    return () => setUnsavedFiles(root, false);
  }, [root, anyDirty]);

  // A page left with unsaved edits asks first.
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const open = (path: string) => {
    const next = openTab(tabs, path, buffers.dirty);
    setFull(next === null);
    if (next === null) return;
    setTabs(next);
    buffers.retain(next);
    setActive(path);
    setShowTree(false);
  };
  const openTarget = () => {
    const target = useFilesTarget.getState().take(root);
    if (target === null) return;
    open(target.path);
    setLine(target.line === null ? null : { path: target.path, n: target.line, key: target.n });
    if (target.line !== null && /\.(md|markdown)$/i.test(target.path)) buffers.setMode(target.path, "source");
  };
  const openTargetRef = useRef(openTarget);
  useEffect(() => {
    openTargetRef.current = openTarget;
  });
  useEffect(() => {
    if (listedRoot === root && waiting !== undefined) openTargetRef.current();
  }, [listedRoot, root, waiting]);
  const closeNow = (path: string) => {
    const remaining = tabs.filter((tab) => tab !== path);
    setTabs(remaining);
    buffers.retain(remaining);
    setDiscarding(null);
    if (path === active) setActive(remaining.at(-1) ?? null);
  };
  const close = (path: string) => {
    if (buffers.dirty.has(path)) setDiscarding(path);
    else closeNow(path);
  };

  const explorer = (
    <div
      data-slot="explorer-column"
      className={
        phone
          ? "flex min-h-0 flex-1 flex-col"
          : "flex min-h-0 w-explorer shrink-0 flex-col border-r border-border"
      }
    >
      <Explorer root={root} selected={active} onOpen={open} onListed={onListed} />
    </div>
  );
  const panelId = `${ids}-panel`;
  const viewer = (
    <div data-slot="viewer-column" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {phone ? (
        <div className="border-b border-border px-s2 py-s1">
          <Button variant="ghost" size="sm" onClick={() => setShowTree(true)}>
            <Icon icon={IconBack} size={14} />
            {t("files.viewer.back")}
          </Button>
        </div>
      ) : null}
      <ViewerTabs
        tabs={tabs}
        active={active}
        idPrefix={ids}
        panelId={panelId}
        dirty={buffers.dirty}
        onSelect={(path) => {
          setLine(null); // a tab picked by hand keeps its own cursor
          setActive(path);
        }}
        onClose={close}
      />
      {full ? (
        <div className="px-s3 py-s1">
          <InlineError announce="action">{t("files.tabs.full")}</InlineError>
        </div>
      ) : null}
      {discarding === null ? null : (
        <div className="border-b border-border px-s3 py-s2">
          <div role="group" aria-label={t("files.edit.discard")} className="flex flex-col items-start gap-s2">
            <p className="text-ui text-fg">{t("files.edit.discard")}</p>
            <div className="flex gap-s2">
              <Button variant="primary" onClick={() => closeNow(discarding)}>
                {t("files.edit.discardConfirm")}
              </Button>
              <Button onClick={() => setDiscarding(null)}>{t("files.edit.cancel")}</Button>
            </div>
          </div>
        </div>
      )}
      {active === null ? (
        <div className="p-s3">
          <EmptyState title={t("files.pane.title")} purpose={t("files.viewer.empty")} />
        </div>
      ) : (
        <FileViewer
          key={active}
          path={active}
          panelId={panelId}
          tabId={tabIdOf(ids, active)}
          buffers={buffers}
          stepUp={stepUp}
          {...(line?.path === active ? { line: { n: line.n, key: line.key } } : {})}
        />
      )}
    </div>
  );
  return (
    <div data-files-pane={root} className="flex min-h-0 flex-1">
      {stepUp.prompt}
      {phone ? (
        showTree ? (
          explorer
        ) : (
          viewer
        )
      ) : (
        <>
          {explorer}
          {viewer}
        </>
      )}
    </div>
  );
}
