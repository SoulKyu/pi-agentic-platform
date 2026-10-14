import type { FileMeta } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { click, mount, settle, typeInto, button } from "../../testing/dom.ts";
import { entry, filesBed, meta } from "./files-bed.ts";
import { FilesPane, type StepUp } from "./FilesPane.tsx";
import { resetFolderMemory } from "./folder-memory.ts";

export interface Disk {
  text: string;
  etag: string;
  mtimeMs: number;
  patch: Partial<FileMeta>;
}
export const ETAG_1 = "1".repeat(32);
export const ETAG_2 = "2".repeat(32);
export const ETAG_3 = "3".repeat(32);
export const NAMES = [
  "a.ts",
  "b.ts",
  "c.md",
  "d.md",
  ...Array.from({ length: 6 }, (_, index) => `e${index}.ts`),
];
/** The fake daemon of the editing tests: its files by path, and the runtime that serves them. */
export const world = {
  bed: undefined as unknown as ReturnType<typeof filesBed>,
  disk: new Map<string, Disk>(),
};
export const stepUpAsk = vi.fn(async () => true);
export const stepUp: StepUp = {
  prompt: null,
  run: async (attempt, commandId) => {
    try {
      return await attempt(commandId);
    } catch (failure) {
      if (failure instanceof RpcError && failure.code === "step_up_required" && (await stepUpAsk())) {
        return attempt(commandId);
      }
      throw failure;
    }
  },
};

export const writes = () => world.bed.called("files.write");
export const writeParams = (index = 0) => writes()[index]?.params as Record<string, unknown>;
export const reads = () => world.bed.called("files.read");
export const diskOf = (path: string): Disk => world.disk.get(path) as Disk;

export function resetWorld(setRuntime: (runtime: Runtime) => void): void {
  localStorage.clear();
  resetFolderMemory();
  stepUpAsk.mockReset().mockResolvedValue(true);
  world.disk = new Map(
    NAMES.map((name) => [
      `/p/${name}`,
      { text: `disk ${name}`, etag: ETAG_1, mtimeMs: 100, patch: {} } satisfies Disk,
    ]),
  );
  const bed = filesBed({ "/p": NAMES.map((name) => entry(name)) });
  world.bed = bed;
  bed.handlers["files.read"] = (params) => {
    const { path } = params as { path: string };
    const file = world.disk.get(path);
    if (!file) throw new RpcError("not_found");
    return {
      meta: meta(path, { etag: file.etag, mtimeMs: file.mtimeMs, ...file.patch }),
      text: file.text,
      offset: 0,
      nextOffset: null,
    };
  };
  bed.handlers["files.write"] = (params) => {
    const { path, text: saved } = params as { path: string; text: string };
    const file = diskOf(path);
    Object.assign(file, { text: saved, etag: ETAG_2, mtimeMs: 200 });
    return { meta: meta(path, { etag: ETAG_2, mtimeMs: 200, ...file.patch }) };
  };
  setRuntime(bed.runtime);
}

export async function show(): Promise<HTMLElement> {
  const page = await mount(
    <TooltipProvider>
      <FilesPane root="/p" stepUp={stepUp} />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
}
export const open = async (c: HTMLElement, name: string) => {
  await click(c.querySelector(`[role="treeitem"][data-path="/p/${name}"]`) as HTMLElement);
  await settle();
};
export const editor = (c: HTMLElement) => c.querySelector('[data-slot="code-editor"]') as HTMLTextAreaElement;
export const type = async (c: HTMLElement, value: string) => {
  await typeInto(editor(c), value);
};
export const save = async (c: HTMLElement) => {
  await click(button(c, "Save"));
  await settle();
};
export const tabNames = (c: HTMLElement) =>
  [...c.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
