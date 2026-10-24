import type { VcsStatus } from "@pap/contracts";
import { Banner, Button, EmptyState, Icon, IconBack, IconRefresh, Spinner, useIsPhone } from "@pap/ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import "../../i18n/register-changes.ts";
import { useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { useOnBoxRunning } from "../../stores/box-phase.ts";
import { feedVcs } from "../../stores/vcs-feed.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import { BoxStopped } from "../boxes/BoxStopped.tsx";
import { PushBar } from "../github/PushBar.tsx";
import { ChangeList } from "./ChangeList.tsx";
import { displayPath } from "./changes.vm.ts";
import { FileDiff } from "./FileDiff.tsx";
import { useRefreshTriggers } from "./use-refresh.ts";

interface ChangesPaneProps {
  readonly root: string;
  /** Shows a file in the Files pane; the shell gives it (features never import each other). */
  onOpenFile(absolutePath: string): void;
  /** The clock of the focus throttle; tests give their own. */
  readonly now?: () => number;
}

const ERROR_KEYS = {
  git_missing: "changes.state.gitMissing",
  timeout: "changes.state.timeout",
  failed: "changes.state.failed",
  too_large: "changes.state.tooLarge",
} as const;

/** The git changes of one folder (M8R79): a header, the changed files in groups, and the diff of the selected one. */
export function ChangesPane({ root, onOpenFile, now }: ChangesPaneProps) {
  const t = useT();
  const phone = useIsPhone();
  const known = useVcsStore((state) => state.view.statuses.has(root));
  const status: VcsStatus | null = useVcsStore((state) => state.view.statuses.get(root) ?? null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showList, setShowList] = useState(true);
  const [watchFailed, setWatchFailed] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // A box project's `vcs` answers `box_stopped` while the box is stopped; it is watched again once the box runs (R3).
  const [stopped, setStopped] = useState(false);
  const [watch, setWatch] = useState(0);
  useOnBoxRunning(root, () => {
    setStopped(false);
    setWatchFailed(false);
    setWatch((count) => count + 1);
  });

  useEffect(
    () =>
      feedVcs(getRuntime().subscriptions, root, (code) => {
        if (code === "box_stopped") setStopped(true);
        else setWatchFailed(true);
      }),
    [root, watch],
  );

  const refresh = useCallback(() => {
    getRuntime()
      .rpc.call("vcs.refresh", { root })
      .then(
        () => setRefreshFailed(false),
        (failure: unknown) => {
          if (failure instanceof RpcError && failure.code === "box_stopped") setStopped(true);
          else setRefreshFailed(true);
        },
      );
  }, [root]);
  useRefreshTriggers(root, refresh, now ?? Date.now);

  const refreshButton = (
    <Button variant="secondary" size="sm" onClick={refresh}>
      <Icon icon={IconRefresh} size={14} />
      {t("changes.refresh")}
    </Button>
  );

  let body;
  if (stopped) {
    body = <BoxStopped path={root} />;
  } else if (watchFailed && !known) {
    body = (
      <div className="p-s3">
        <Banner tone="capacity" title={t("changes.state.watchFailed")} />
      </div>
    );
  } else if (!known) {
    body = (
      <div className="flex items-center gap-s2 p-s3 text-ui text-muted">
        <Spinner label={t("changes.state.loading")} />
      </div>
    );
  } else if (status === null || !status.repo) {
    body = (
      <div className="p-s3">
        <EmptyState
          title={t("changes.state.notRepo")}
          purpose={t("changes.state.notRepoPurpose")}
          action={refreshButton}
        />
      </div>
    );
  } else {
    body = (
      <Repository
        root={root}
        status={status}
        selectedPath={selectedPath}
        showList={!phone || showList}
        showDiff={!phone || !showList}
        onSelect={(path) => {
          setSelectedPath(path);
          setShowList(false);
        }}
        onBack={() => setShowList(true)}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <div data-changes-pane={root} className="flex min-h-0 flex-1 flex-col">
      {!stopped && known && status?.repo === true ? (
        <Header status={status} refreshButton={refreshButton} refreshFailed={refreshFailed} />
      ) : null}
      {!stopped && known && status?.repo === true ? <PushBar root={root} /> : null}
      {body}
    </div>
  );
}

function Header({
  status,
  refreshButton,
  refreshFailed,
}: {
  readonly status: VcsStatus;
  readonly refreshButton: ReactNode;
  readonly refreshFailed: boolean;
}) {
  const t = useT();
  const branch = status.detached || status.branch === null ? t("changes.branch.detached") : status.branch;
  return (
    <div
      data-slot="changes-header"
      className="flex flex-wrap items-center gap-x-s3 gap-y-s1 border-b border-border px-s3 py-s2"
    >
      <span className="min-w-0 truncate font-mono text-code text-fg">{displayPath(branch)}</span>
      {status.upstream === null ? null : (
        <span className="flex items-center gap-s2 font-mono text-code tabular-nums text-muted">
          <span>
            <span aria-hidden>{`↑${status.ahead}`}</span>
            <span className="sr-only">{t("changes.sync.ahead", { count: String(status.ahead) })}</span>
          </span>
          <span>
            <span aria-hidden>{`↓${status.behind}`}</span>
            <span className="sr-only">{t("changes.sync.behind", { count: String(status.behind) })}</span>
          </span>
        </span>
      )}
      <span className="font-mono text-code tabular-nums text-muted">
        {`+${status.additions} −${status.deletions}`}
      </span>
      <span className="ms-auto flex items-center gap-s2">
        {refreshFailed ? (
          <span role="status" className="text-ui text-attn">
            {t("changes.refresh.failed")}
          </span>
        ) : null}
        {refreshButton}
      </span>
    </div>
  );
}

interface RepositoryProps {
  readonly root: string;
  readonly status: VcsStatus;
  readonly selectedPath: string | null;
  readonly showList: boolean;
  readonly showDiff: boolean;
  onSelect(path: string): void;
  onBack(): void;
  onOpenFile(path: string): void;
}

function Repository({
  root,
  status,
  selectedPath,
  showList,
  showDiff,
  onSelect,
  onBack,
  onOpenFile,
}: RepositoryProps) {
  const t = useT();
  const selected = status.files.find((file) => file.path === selectedPath) ?? null;
  const notices = (
    <>
      {status.error === null ? null : (
        <div className="px-s3 pt-s2">
          <Banner tone="capacity" title={t(ERROR_KEYS[status.error])} />
        </div>
      )}
      {status.truncated ? (
        <div className="px-s3 pt-s2">
          <Banner tone="capacity" title={t("changes.state.truncated")} />
        </div>
      ) : null}
    </>
  );
  if (status.files.length === 0) {
    return (
      <div className="flex flex-col">
        {notices}
        {status.error === null ? (
          <div className="p-s3">
            <EmptyState title={t("changes.state.clean")} purpose={t("changes.state.cleanPurpose")} />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      {showList ? (
        <div
          data-slot="change-list-column"
          className={
            showDiff
              ? "flex min-h-0 w-explorer shrink-0 flex-col overflow-y-auto border-r border-border"
              : "flex min-h-0 flex-1 flex-col overflow-y-auto"
          }
        >
          {notices}
          <ChangeList files={status.files} selected={selected?.path ?? null} onSelect={onSelect} />
        </div>
      ) : null}
      {showDiff ? (
        <div data-slot="diff-column" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {showList ? null : (
            <div className="border-b border-border px-s2 py-s1">
              <Button variant="ghost" size="sm" onClick={onBack}>
                <Icon icon={IconBack} size={14} />
                {t("changes.diff.back")}
              </Button>
            </div>
          )}
          {selected === null ? (
            <p className="p-s3 text-ui text-muted">{t("changes.diff.pick")}</p>
          ) : (
            <FileDiff key={selected.path} root={root} file={selected} onOpenFile={onOpenFile} />
          )}
        </div>
      ) : null}
    </div>
  );
}
