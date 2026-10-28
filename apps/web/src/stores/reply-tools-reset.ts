import { useComposerInsert } from "./composer-insert.ts";
import { useFilesTarget } from "./files-target.ts";
import { useKnowledgeEnabled } from "./knowledge-enabled.ts";
import { useReplyPorts } from "./reply-ports.ts";
import { useShellAnswers } from "./shell-answers.ts";
import { useTerminalTypists } from "./terminal-typists.ts";

/** Every UX-1 store's sign-out reset (MC34): the next account starts from nothing. */
export function resetReplyTools(): void {
  useReplyPorts.getState().reset();
  useFilesTarget.getState().reset();
  useTerminalTypists.getState().reset();
  useShellAnswers.getState().reset();
  useComposerInsert.getState().reset();
  useKnowledgeEnabled.getState().reset();
}
