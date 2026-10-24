import "../../i18n/register-home.ts";
import "../../i18n/register-boxes.ts";
import { useEffect } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import type { HomeMode } from "./home-mode.ts";
import { modeReasons, useGitFact } from "./project-facts.ts";

/** Why some modes cannot run in the project at `root`. */
export interface ModeFacts {
  readonly root: string;
  readonly reasons: Partial<Record<HomeMode, MessageKey>>;
}

export interface ProjectFactsProps {
  readonly root: string;
  /** A box project: its files are not on this machine, so there is no host repository to ask about. */
  readonly box: boolean;
  /** A state setter: it must stay the same function between renders. */
  onFacts(facts: ModeFacts): void;
}

/**
 * Headless: asks what the project allows (a repository? automation running?) and tells the composer why a mode cannot
 * run. Its own chunk with the reason words (PH12: an unknown fact never disables, so the first paint waits for none).
 */
export default function ProjectFacts({ root, box, onFacts }: ProjectFactsProps) {
  const git = useGitFact(box ? null : root);
  const counts = useTasksStore((state) => state.view.counts);
  useEffect(() => {
    onFacts({ root, reasons: modeReasons({ git, counts, box }) });
  }, [root, git, counts, box, onFacts]);
  return null;
}
