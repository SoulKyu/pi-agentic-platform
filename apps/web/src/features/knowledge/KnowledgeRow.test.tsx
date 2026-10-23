// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { KnowledgeRow } from "./KnowledgeRow.tsx";
import { useKnowledgeStore } from "./knowledge-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let state: { enabled: boolean; concepts: number };

beforeEach(() => {
  setLocale("en");
  state = { enabled: false, concepts: 0 };
  bed = fakeRuntime("open");
  bed.handlers["projects.knowledge"] = () => state;
  bed.handlers["projects.enableKnowledge"] = () => {
    state = { enabled: true, concepts: 3 };
    return { enabled: true };
  };
  current.runtime = bed.runtime;
  useKnowledgeStore.setState({ versions: {}, pending: {}, origin: {} });
});

describe("KnowledgeRow", () => {
  it("shows the purpose and ENABLE OKF while the project has no bundle", async () => {
    const page = await mount(<KnowledgeRow projectId="p1" />);
    await settle();
    expect(text(page.container)).toContain(
      "Agents in this project keep their knowledge as markdown files in knowledge/.",
    );
    expect(button(page.container, "ENABLE OKF")).toBeTruthy();
    expect(page.container.querySelector("code")?.textContent).toBe("knowledge/");
  });

  it("enables once, bumps the store and shows the present line with the count", async () => {
    const page = await mount(<KnowledgeRow projectId="p1" />);
    await settle();
    await click(button(page.container, "ENABLE OKF"));
    await settle();
    expect(bed.called("projects.enableKnowledge")).toHaveLength(1);
    expect(bed.called("projects.enableKnowledge")[0]?.params).toEqual({ projectId: "p1" });
    expect(useKnowledgeStore.getState().versions["p1"]).toBe(1);
    expect(text(page.container)).toBe("OKF knowledge in knowledge/ · 3 concepts");
  });

  it("says what happened when the enable is refused, and keeps the button", async () => {
    bed.handlers["projects.enableKnowledge"] = () => {
      throw new RpcError("conflict");
    };
    const page = await mount(<KnowledgeRow projectId="p1" />);
    await settle();
    await click(button(page.container, "ENABLE OKF"));
    await settle();
    expect(alerts(page.container)).toHaveLength(1);
    expect(alerts(page.container)[0]).toBe(
      'OKF was not enabled: knowledge/ is a link or a file, or its index.md has no okf_version. Nothing was written. Rename it, or add okf_version: "0.2" to its index.md, then try again.',
    );
    expect(button(page.container, "ENABLE OKF")).toBeTruthy();
    expect(useKnowledgeStore.getState().versions["p1"]).toBeUndefined();
  });

  it("says what happened, what is intact and what to do when the folder cannot be written, in French too", async () => {
    bed.handlers["projects.enableKnowledge"] = () => {
      throw new RpcError("internal");
    };
    const page = await mount(<KnowledgeRow projectId="p1" />);
    await settle();
    await click(button(page.container, "ENABLE OKF"));
    await settle();
    expect(alerts(page.container)[0]).toBe(
      "OKF was not enabled: the folder cannot be written or no longer exists. Nothing was written. Check that it exists and that pap may write in it, then try again.",
    );
    setLocale("fr");
    const fr = await mount(<KnowledgeRow projectId="p1" />);
    await settle();
    await click(button(fr.container, "ACTIVER OKF"));
    await settle();
    expect(alerts(fr.container)[0]).toContain("Rien n'a été écrit.");
  });

  it("reads and enables the recorded session's folder, says so, and marks that session pending", async () => {
    useKnowledgeStore.getState().setOrigin("p1", { sessionId: "lane1", live: true, lane: true });
    const page = await mount(<KnowledgeRow projectId="p1" />);
    await settle();
    expect(text(page.container)).toContain("In this lane's worktree");
    await click(button(page.container, "ENABLE OKF"));
    await settle();
    expect(bed.called("projects.knowledge")[0]?.params).toEqual({ projectId: "p1", sessionId: "lane1" });
    expect(bed.called("projects.enableKnowledge")[0]?.params).toEqual({
      projectId: "p1",
      sessionId: "lane1",
    });
    expect(useKnowledgeStore.getState().pending["lane1"]).toBe(true);
    await page.unmount();
    expect(useKnowledgeStore.getState().origin["p1"]).toBeUndefined();
  });

  it("works on the project root without a recorded session", async () => {
    const page = await mount(<KnowledgeRow projectId="p1" />);
    await settle();
    expect(text(page.container)).not.toContain("lane's worktree");
    expect(bed.called("projects.knowledge")[0]?.params).toEqual({ projectId: "p1" });
  });

  it("speaks French", async () => {
    setLocale("fr");
    state = { enabled: true, concepts: 2 };
    const page = await mount(<KnowledgeRow projectId="p1" />);
    await settle();
    expect(text(page.container)).toBe("Connaissances OKF dans knowledge/ · 2 concepts");
  });
});
