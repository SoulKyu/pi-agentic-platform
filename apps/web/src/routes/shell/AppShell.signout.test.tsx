// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { remember, rememberedRoots, resetFolderMemory } from "../../features/files/folder-memory.ts";
import { RpcError } from "../../runtime/rpc.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { usePaletteRequest } from "../../stores/palette-request.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { hasUnsavedFiles, resetUnsavedFiles, setUnsavedFiles } from "../../stores/unsaved-files.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import { settle } from "../../testing/dom.ts";
import { terminalView, vcsFile, vcsStatus } from "../../testing/m8-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { terminalFor, terminalMemory } from "./surface-terminal.ts";
import { useTerminalReady } from "./surface-view.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p") };
});

beforeEach(() => {
  resetFolderMemory();
  resetUnsavedFiles();
  useVcsStore.getState().reset();
  useTerminalStore.getState().reset();
});

describe("sign-out wipes the M8 client stores (MC34)", () => {
  it("leaves the vcs and terminal stores, unsaved roots, folder memory and terminal maps empty", async () => {
    const bed = fakeRuntime("idle");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    bed.handlers["terminal.create"] = (params) => {
      const { sessionId } = params as { sessionId: string };
      if (sessionId === "ok") return { terminalId: "t-ok" };
      if (sessionId === "slow") return new Promise(() => {});
      throw new RpcError("timeout");
    };
    current.runtime = bed.runtime;
    const page = await renderShell("/");
    await settle();

    useVcsStore
      .getState()
      .apply("/p", { kind: "snapshot", status: vcsStatus("/p", { files: [vcsFile("a.ts")] }) });
    useTerminalStore.getState().apply({ kind: "snapshot", terminals: [terminalView(1)] });
    setUnsavedFiles("/p", true);
    remember("/p", ["/p/src"]);
    useTerminalReady.getState().set(true);
    void terminalFor("slow", "/p");
    await terminalFor("ok", "/p");
    await terminalFor("lost", "/p");
    expect(terminalMemory()).toEqual({ recent: 1, inFlight: 1, unknownOutcome: 1 });
    expect(useVcsStore.getState().view.statuses.size).toBe(1);
    expect(useTerminalStore.getState().view.list).toHaveLength(1);
    expect(hasUnsavedFiles("/p")).toBe(true);
    expect(rememberedRoots()).toBe(1);

    useComposerPrefill.getState().push("s1", "Review comments");
    useTriggerPrefill.getState().put("p1", { name: "n", prompt: "p" });

    useSecretDialog.getState().open("r1");
    useAddProjectRequest.getState().ask(() => {});
    usePaletteRequest.getState().askSearch("p1");

    await page.unmount();

    expect(useSecretDialog.getState().requestId).toBeNull();
    expect(useAddProjectRequest.getState().open).toBe(false);
    expect(useAddProjectRequest.getState().onAdded).toBeNull();
    expect(usePaletteRequest.getState().search).toBeNull();
    expect(useComposerPrefill.getState().take("s1")).toBeNull();
    expect(useTriggerPrefill.getState().items).toEqual({});

    expect(useVcsStore.getState().view.statuses.size).toBe(0);
    expect(useTerminalStore.getState().view.list).toEqual([]);
    expect(hasUnsavedFiles("/p")).toBe(false);
    expect(rememberedRoots()).toBe(0);
    expect(terminalMemory()).toEqual({ recent: 0, inFlight: 0, unknownOutcome: 0 });
  });
});
