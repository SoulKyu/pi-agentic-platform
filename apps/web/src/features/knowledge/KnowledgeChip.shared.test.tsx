// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useKnowledgeEnabled } from "../../stores/knowledge-enabled.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { KnowledgeChip } from "./KnowledgeChip.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

beforeEach(() => {
  setLocale("en");
  useKnowledgeEnabled.getState().reset();
  const bed = fakeRuntime("open");
  bed.handlers["projects.knowledge"] = () => ({ enabled: true, concepts: 0 });
  current.runtime = bed.runtime;
});

describe("KnowledgeChip", () => {
  it("the chip's answer is shared in the knowledge store and cleared at unmount", async () => {
    const page = await mount(<KnowledgeChip projectId="p1" sessionId="s1" status="idle" />);
    await settle();
    expect(useKnowledgeEnabled.getState().enabled).toEqual({ s1: true });
    await page.unmount();
    expect(useKnowledgeEnabled.getState().enabled).toEqual({});
  });
});
