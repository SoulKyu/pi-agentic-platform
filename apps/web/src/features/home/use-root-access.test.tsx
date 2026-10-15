// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { useRootAccess } from "./use-root-access.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

function Probe({ root }: { readonly root: string | null }) {
  return <p data-reason="">{useRootAccess(root) ?? "open"}</p>;
}
const reason = () => document.querySelector("[data-reason]")?.textContent;

describe("useRootAccess", () => {
  let bed: ReturnType<typeof fakeRuntime>;
  beforeEach(() => {
    bed = fakeRuntime("open");
    current.runtime = bed.runtime;
  });

  it("answers the refusal of the root, and nothing for a failed check", async () => {
    bed.handlers["files.list"] = () => {
      throw new RpcError("forbidden");
    };
    await mount(<Probe root="/w/a" />);
    await settle();
    expect(reason()).toBe("home.reason.rootRefused");
  });

  it("ignores a stale answer for the previous root", async () => {
    const pending = new Map<string, (value: unknown) => void>();
    bed.handlers["files.list"] = (params: unknown) =>
      new Promise((resolve, reject) => {
        const path = (params as { path: string }).path;
        pending.set(path, path === "/w/b" ? () => reject(new RpcError("not_found")) : resolve);
      });
    const page = await mount(<Probe root="/w/a" />);
    await page.rerender(<Probe root="/w/b" />);
    await settle();
    pending.get("/w/b")?.(undefined);
    await settle();
    pending.get("/w/a")?.({ entries: [], truncated: false });
    await settle();
    expect(reason()).toBe("home.reason.rootRefused");
  });
});
