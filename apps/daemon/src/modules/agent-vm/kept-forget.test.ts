import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createKeptForget } from "./kept-forget.ts";
import { processRootOf } from "./layouts.ts";
import { createFakeVmd } from "./testing/fake-vmd.ts";

const KEEP = "d".repeat(32);

describe("forgetting a kept folder (K2)", () => {
  it("under Kata asks pap-vmd to delete the kept disk and nothing else", async () => {
    const fake = createFakeVmd();
    await createKeptForget({ client: fake, papHome: "/p", logger: silentLogger, remove: vi.fn() })(
      "atlas-1a2b",
      KEEP,
    );
    expect(fake.requests).toEqual([
      {
        op: "disk.delete",
        box: { kind: "agent", id: "atlas-1a2b" },
        taskKey: null,
        keepKey: KEEP,
        purge: true,
      },
    ]);
  });

  it("under the process backend removes the process root keyed by the keep key", async () => {
    const remove = vi.fn();
    await createKeptForget({ client: null, papHome: "/p", logger: silentLogger, remove })("atlas-1a2b", KEEP);
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      processRootOf("/p", { agentId: "atlas-1a2b", taskKey: KEEP }),
    );
  });

  it("answers busy for a disk a live VM holds or a pap-vmd that fails (the caller retries), and logs the failures", async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger, warn };
    const fake = createFakeVmd();
    fake.failNext("disk.delete", "conflict");
    const forget = createKeptForget({ client: fake, papHome: "/p", logger, remove: vi.fn() });
    await expect(forget("atlas-1a2b", KEEP)).resolves.toBe("busy");
    expect(warn).not.toHaveBeenCalled();
    fake.failNext("disk.delete", "not_found");
    await expect(forget("atlas-1a2b", KEEP)).resolves.toBe("done");
    await expect(forget("atlas-1a2b", KEEP)).resolves.toBe("done");
    expect(warn).not.toHaveBeenCalled();
    const remove = vi.fn(() => {
      throw new Error("busy");
    });
    await expect(
      createKeptForget({ client: null, papHome: "/p", logger, remove })("atlas-1a2b", KEEP),
    ).resolves.toBe("busy");
    expect(warn).toHaveBeenCalledTimes(1);
    const down = createKeptForget({
      client: { request: vi.fn().mockRejectedValue(new Error("socket closed")) } as never,
      papHome: "/p",
      logger,
      remove: vi.fn(),
    });
    await expect(down("atlas-1a2b", KEEP)).resolves.toBe("busy");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
