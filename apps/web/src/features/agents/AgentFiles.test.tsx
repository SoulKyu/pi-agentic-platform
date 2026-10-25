// @vitest-environment happy-dom
import { AGENT_FILE_LIMITS } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/index.ts";
import {
  alerts,
  statuses,
  button,
  click,
  field,
  hasButton,
  mount,
  settle,
  text,
  typeInto,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentFiles } from "./AgentFiles.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const ID = "atlas-1a2b";
const kube = { path: ".kube/config", size: 2048, importedAt: Date.UTC(2026, 9, 20, 9, 0) };
let bed: ReturnType<typeof fakeRuntime>;
let files: Array<typeof kube>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  files = [kube];
  bed.handlers["agents.files.list"] = () => ({ files });
  bed.handlers["agents.files.remove"] = () => ({ ok: true });
  fetchMock = vi.fn(async () => new Response(JSON.stringify(kube), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const show = async () => {
  const page = await mount(<AgentFiles agentId={ID} />);
  await settle();
  return page;
};
const choose = async (input: HTMLInputElement, file: File) => {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const picker = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLInputElement>(`input[type="file"][aria-label="${label}"]`) as HTMLInputElement;
const sentTo = () => fetchMock.mock.calls.map((call) => [call[0], (call[1] as RequestInit).method]);

describe("the Files tab (sub-project 2, spec 7)", () => {
  it("lists the path in mono, the size in tabular figures and the date, never the content", async () => {
    const page = await show();
    const row = page.container.querySelector("tbody tr") as HTMLElement;
    const cells = [...row.querySelectorAll("td")];
    expect(cells[0]?.textContent).toBe(".kube/config");
    expect(cells[0]?.className).toContain("font-mono");
    expect(cells[1]?.textContent).toBe("2.0 KiB");
    expect(cells[1]?.className).toContain("tabular-nums");
    expect(cells[2]?.textContent).toMatch(/2026/);
    expect(bed.called("agents.files.list")).toEqual([expect.objectContaining({ params: { agentId: ID } })]);
  });

  it("shows an EmptyState with one primary action when there is no file", async () => {
    files = [];
    const page = await show();
    const empty = page.container.querySelector('[data-slot="empty-state"]') as HTMLElement;
    expect(empty.textContent).toContain("No file yet");
    expect(page.container.querySelector("table")).toBeNull();
    expect(empty.querySelectorAll("button")).toHaveLength(1);
  });

  it("IMPORT sends PUT /agent-files with the typed path and the raw file", async () => {
    files = [];
    const page = await show();
    const input = picker(page.container, "File to import");
    const chosen = new File(["apiVersion: v1"], "config");
    await choose(input, chosen);
    await typeInto(field(page.container, "Path in the agent's home") as HTMLInputElement, ".kube/config");
    await click(button(page.container, "Import"));
    await settle();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/agent-files?agentId=${ID}&path=.kube%2Fconfig`);
    expect(init).toMatchObject({ method: "PUT", credentials: "same-origin", body: chosen });
    expect(bed.called("agents.files.list").length).toBe(2);
  });

  it("refuses a bad path before any upload", async () => {
    files = [];
    const page = await show();
    await choose(picker(page.container, "File to import"), new File(["x"], "a"));
    await typeInto(field(page.container, "Path in the agent's home") as HTMLInputElement, "../etc/passwd");
    expect((button(page.container, "Import") as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a file over 1 MiB before upload, with a message", async () => {
    files = [];
    const page = await show();
    const big = new File([new Uint8Array(AGENT_FILE_LIMITS.maxBytes + 1)], "big");
    await choose(picker(page.container, "File to import"), big);
    expect(alerts(page.container).join(" ")).toContain("1 MiB");
    expect((button(page.container, "Import") as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says what happened when the server refuses an import", async () => {
    files = [];
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "limit_reached" } }), { status: 409 }),
    );
    const page = await show();
    await choose(picker(page.container, "File to import"), new File(["x"], "a"));
    await typeInto(field(page.container, "Path in the agent's home") as HTMLInputElement, "a");
    await click(button(page.container, "Import"));
    await settle();
    expect(alerts(page.container).join(" ")).toContain("32 files");
  });

  it("REPLACE re-imports to the same path", async () => {
    const page = await show();
    await click(button(page.container, "Replace .kube/config"));
    const replacement = new File(["new"], "other-name");
    await choose(picker(page.container, "Replacement file"), replacement);
    await settle();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/agent-files?agentId=${ID}&path=.kube%2Fconfig`);
    expect(init).toMatchObject({ method: "PUT", body: replacement });
  });

  it("REMOVE asks first, then calls agents.files.remove", async () => {
    const page = await show();
    await click(button(page.container, "Remove .kube/config"));
    expect(bed.called("agents.files.remove")).toEqual([]);
    expect(text(page.container)).toContain("cannot be undone");
    files = [];
    await click(button(page.container, "Remove file"));
    await settle();
    expect(bed.called("agents.files.remove")).toEqual([
      expect.objectContaining({ params: { agentId: ID, path: ".kube/config" } }),
    ]);
    expect(text(page.container)).toContain("No file yet");
  });

  it("Keep leaves the file alone", async () => {
    const page = await show();
    await click(button(page.container, "Remove .kube/config"));
    await click(button(page.container, "Keep"));
    expect(bed.called("agents.files.remove")).toEqual([]);
    expect(hasButton(page.container, "Remove .kube/config")).toBe(true);
    expect(sentTo()).toEqual([]);
  });

  it("says the list could not be read", async () => {
    bed.handlers["agents.files.list"] = () => {
      throw new RpcError("internal");
    };
    const page = await show();
    expect(statuses(page.container).join(" ")).toContain("could not be read");
  });
});
