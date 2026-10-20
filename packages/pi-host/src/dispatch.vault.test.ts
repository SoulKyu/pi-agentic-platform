import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { VaultUpdateRecord } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Approvals } from "./approvals.ts";
import { createDispatch } from "./dispatch.ts";
import type { Ipc } from "./ipc.ts";
import type { UiBridge } from "./ui-bridge.ts";

const deps = (vault?: { update(record: VaultUpdateRecord): void }) => ({
  papHome: "/pap",
  applyTaint: () => {},
  session: {} as AgentSession,
  ipc: { send: () => true } as unknown as Ipc,
  ui: {} as UiBridge,
  approvals: {} as Approvals,
  leafMayHaveMoved: () => {},
  setRules: () => {},
  ...(vault ? { vault } : {}),
});

describe("dispatch: vault_update (M11R26)", () => {
  it("hands the record to the worker's vault", () => {
    const update = vi.fn();
    const record: VaultUpdateRecord = {
      type: "vault_update",
      vault: { VAULT_TOKEN: "vault-0123456789" },
      once: [],
    };
    createDispatch(deps({ update }))(record);
    expect(update).toHaveBeenCalledExactlyOnceWith(record);
  });

  it("ignores the record when the worker has no vault (a plain session)", () => {
    expect(() =>
      createDispatch(deps())({ type: "vault_update", vault: { A_NAME: "value-0123456789" }, once: [] }),
    ).not.toThrow();
  });

  it("a throwing handler never reaches the dispatcher's caller, and says nothing of the values", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const update = () => {
        throw new Error("boom value-0123456789");
      };
      expect(() =>
        createDispatch(deps({ update }))({
          type: "vault_update",
          vault: { A_NAME: "value-0123456789" },
          once: [],
        }),
      ).not.toThrow();
      const logged = write.mock.calls.map((call) => String(call[0])).join("");
      expect(logged).toContain("vault_update");
      expect(logged).not.toContain("value-0123456789");
    } finally {
      write.mockRestore();
    }
  });
});

// Mutant V1: drop the `if (deps.vm)` branch (the record reaches the vault in a VM session): "drops the record in a VM session".
describe("dispatch: vault_update in a VM session (R11)", () => {
  it("drops the record, logs the type once, never the values", () => {
    const update = vi.fn();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dispatch = createDispatch({ ...deps({ update }), vm: true });
    const record: VaultUpdateRecord = {
      type: "vault_update",
      vault: { A_NAME: "value-0123456789" },
      once: [],
    };
    dispatch(record);
    dispatch(record);
    const logged = write.mock.calls.map((call) => String(call[0])).join("");
    write.mockRestore();
    expect(update).not.toHaveBeenCalled();
    expect(logged).toBe("pi-host: vault_update dropped in a VM session\n");
  });
});
