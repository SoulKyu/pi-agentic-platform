import type { LaneView, VcsFile } from "@pap/contracts";
import { usePendingAction } from "@pap/ui";
import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedVcs } from "../../stores/vcs-feed.ts";
import { useLaneShip } from "../../stores/lane-ship-store.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import {
  COMMIT_REFUSED,
  commitPaths,
  MAX_COMMIT_PATHS,
  PUSH_REFUSED,
  pushModel,
  SUGGEST_REFUSED,
  tickedCount,
  type PushModel,
} from "./commit-bar.vm.ts";
import { failureKey } from "./failure-text.ts";
import { pushLane, pushRunning } from "./lane-calls.ts";

export type CommitAction = "suggest" | "commit" | "push";
interface Note {
  readonly key: MessageKey;
  readonly vars: Record<string, string | number>;
}

export interface CommitBarState {
  readonly files: readonly VcsFile[];
  /** False until the worktree's first status arrived. */
  readonly known: boolean;
  readonly watchFailed: boolean;
  readonly truncated: boolean;
  readonly unticked: ReadonlySet<string>;
  readonly ticked: number;
  readonly tooMany: boolean;
  readonly message: string;
  /** A suggestion held back because a typed message is in the way. */
  readonly suggestion: string | null;
  readonly note: Note | null;
  readonly problem: MessageKey | null;
  readonly push: PushModel;
  readonly active: CommitAction | null;
  readonly since: number | null;
  readonly canCommit: boolean;
  readonly canSuggest: boolean;
  readonly canPush: boolean;
  edit(message: string): void;
  toggle(path: string): void;
  tickAll(ticked: boolean): void;
  suggest(): void;
  acceptSuggestion(): void;
  keepMessage(): void;
  commit(): void;
  doPush(): void;
}

/**
 * The commit bar's state (M9R91). One action at a time (DESIGN §7.3: the control is disabled at once). A mutation is
 * sent once: a `timeout` is shown as "may still have gone through" and is never retried by the bar.
 */
export function useCommitBar(
  lane: Pick<LaneView, "id" | "facts" | "pushRemote" | "remote">,
  root: string,
): CommitBarState {
  const laneId = lane.id;
  const status = useVcsStore((state) => state.view.statuses.get(root) ?? null);
  const known = useVcsStore((state) => state.view.statuses.has(root));
  const [watchFailed, setWatchFailed] = useState(false);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [active, setActive] = useState<CommitAction | null>(null);
  const typed = useRef("");
  const { since, run } = usePendingAction();

  useEffect(() => feedVcs(getRuntime().subscriptions, root, () => setWatchFailed(true)), [root]);

  const files = status?.files ?? [];
  const paths = commitPaths(files, unticked);
  const ticked = tickedCount(files, unticked);
  const tooMany = paths.length > MAX_COMMIT_PATHS;
  const idle = since === null;
  const hasMessage = message.trim() !== "";
  const push = pushModel(lane);
  const pushing = useLaneShip(laneId).pushing;

  const edit = (next: string) => {
    typed.current = next;
    setMessage(next);
  };
  const start = (action: CommitAction) => {
    setActive(action);
    setProblem(null);
    setNote(null);
  };
  const failed = (failure: unknown, fallback: MessageKey) => setProblem(failureKey(failure, fallback));

  const suggest = () => {
    if (!idle || ticked === 0 || tooMany) return;
    start("suggest");
    setSuggestion(null);
    const { rpc } = getRuntime();
    void run(() =>
      rpc.call("lanes.suggestCommit", { laneId, paths }, { commandId: rpc.newCommandId() }).then(
        (answer) => {
          if (!answer.ok) return setProblem(SUGGEST_REFUSED[answer.reason]);
          if (answer.message.trim() === "") return setProblem(SUGGEST_REFUSED.model_failed);
          // Decided when the answer arrives: the person may have typed while the model was thinking.
          if (typed.current.trim() === "") edit(answer.message);
          else setSuggestion(answer.message);
        },
        (failure: unknown) => failed(failure, "laneCommit.suggest.failed"),
      ),
    );
  };

  const commit = () => {
    if (!idle || !hasMessage || ticked === 0 || tooMany) return;
    start("commit");
    const { rpc } = getRuntime();
    void run(() =>
      rpc
        .call("lanes.commit", { laneId, paths, message: message.trim() }, { commandId: rpc.newCommandId() })
        .then(
          (answer) => {
            if (!answer.ok) return setProblem(COMMIT_REFUSED[answer.reason]);
            edit("");
            setSuggestion(null);
            setNote({ key: "laneCommit.committed", vars: { oid: answer.oid.slice(0, 7) } });
            rpc.call("vcs.refresh", { root }).catch(() => reportClientIssue("command_failed"));
          },
          (failure: unknown) => failed(failure, COMMIT_REFUSED.failed),
        ),
    );
  };

  const doPush = () => {
    if (!idle || pushRunning(laneId) || push.target === null || push.count === 0) return;
    start("push");
    void run(() =>
      pushLane(laneId).then(
        (answer) => {
          if (!answer.ok) return setProblem(PUSH_REFUSED[answer.reason]);
          const target = escapeHidden(`${answer.remote.host}/${answer.remote.path}`);
          setNote({ key: "laneCommit.pushed", vars: { target } });
        },
        (failure: unknown) => failed(failure, PUSH_REFUSED.failed),
      ),
    );
  };

  return {
    files,
    known,
    watchFailed,
    truncated: status?.truncated === true,
    unticked,
    ticked,
    tooMany,
    message,
    suggestion,
    note,
    problem,
    push,
    active,
    since,
    canCommit: idle && hasMessage && ticked > 0 && !tooMany,
    canSuggest: idle && ticked > 0 && !tooMany,
    canPush: idle && !pushing && push.target !== null && push.count !== 0,
    edit,
    toggle: (path) =>
      setUnticked((current) => {
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    tickAll: (all) => setUnticked(all ? new Set() : new Set(files.map((file) => file.path))),
    suggest,
    acceptSuggestion: () => {
      if (suggestion !== null) edit(suggestion);
      setSuggestion(null);
    },
    keepMessage: () => setSuggestion(null),
    commit,
    doPush,
  };
}
