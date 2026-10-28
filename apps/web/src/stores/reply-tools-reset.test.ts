import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerInsert } from "./composer-insert.ts";
import { useFilesTarget } from "./files-target.ts";
import { useKnowledgeEnabled } from "./knowledge-enabled.ts";
import { resetReplyTools } from "./reply-tools-reset.ts";
import { useReplyPorts } from "./reply-ports.ts";
import { useShellAnswers } from "./shell-answers.ts";
import { useTerminalTypists } from "./terminal-typists.ts";

beforeEach(() => resetReplyTools());

describe("resetReplyTools", () => {
  it("resetReplyTools empties every UX-1 store", () => {
    useReplyPorts.getState().register("s1", {
      scope: { base: "/a", roots: ["/a"], filesRoot: "/a", agentId: null },
      openFile: vi.fn(),
    });
    useFilesTarget.getState().push("/a", "/a/f", 1);
    useTerminalTypists.getState().register("t1", { handOff: () => "typed" });
    useShellAnswers.getState().set("b", { since: null, answer: null });
    useComposerInsert.getState().push("s1", "> q\n\n");
    useKnowledgeEnabled.getState().setEnabled("s1", true);
    resetReplyTools();
    expect(useShellAnswers.getState().byBlock).toEqual({});
    expect(useTerminalTypists.getState().typists).toEqual({});
    expect(useReplyPorts.getState().ports).toEqual({});
    expect(useFilesTarget.getState().targets).toEqual({});
    expect(useComposerInsert.getState().items).toEqual({});
    expect(useKnowledgeEnabled.getState().enabled).toEqual({});
  });
});
