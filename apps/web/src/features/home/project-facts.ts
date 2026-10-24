import type { TasksCounts } from "@pap/contracts";
import { useEffect, useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { HomeMode } from "./home-mode.ts";

/**
 * Whether the project's folder is a repository's main checkout (`lanes.preview`), asked once per root. Null until it
 * answers, and when it cannot (PH12: an unknown fact never disables).
 */
export function useGitFact(root: string | null): boolean | null {
  const [fact, setFact] = useState<{ root: string; git: boolean } | null>(null);
  useEffect(() => {
    if (root === null) return undefined;
    let current = true;
    getRuntime()
      .rpc.call("lanes.preview", { projectRoot: root })
      .then(
        (preview) => {
          if (current) setFact({ root, git: preview.repo });
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [root]);
  return fact !== null && fact.root === root ? fact.git : null;
}

/** §3.2 "Ask, don't hide": why a mode cannot run in this project. A mode with no entry can run. */
export function modeReasons(facts: {
  readonly git: boolean | null;
  readonly counts: TasksCounts | null;
  /** A box project: lanes and fan-outs are not there yet. */
  readonly box?: boolean;
}): Partial<Record<HomeMode, MessageKey>> {
  const lanes: MessageKey | null =
    facts.box === true ? "boxes.off" : facts.git === false ? "home.reason.notGit" : null;
  const trigger: MessageKey | null =
    facts.counts?.paused === true
      ? "home.reason.paused"
      : facts.counts?.budgetUsd === 0
        ? "home.reason.noBudget"
        : null;
  return {
    ...(lanes === null ? {} : { lane: lanes, fanout: lanes }),
    ...(trigger === null ? {} : { trigger }),
  };
}
