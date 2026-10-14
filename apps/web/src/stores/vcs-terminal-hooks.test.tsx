// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { terminalView, vcsStatus } from "../testing/m8-fixtures.ts";
import { useTerminalStore, useTerminals } from "./terminal-store.ts";
import { useVcs, useVcsStore } from "./vcs-store.ts";

beforeEach(() => {
  useVcsStore.getState().reset();
  useTerminalStore.getState().reset();
});

function Probe({ root }: { root: string }) {
  const status = useVcs(root);
  const terminals = useTerminals();
  return <p>{`${status?.branch ?? "none"}|${terminals.map((terminal) => terminal.cwd).join(",")}`}</p>;
}

describe("useVcs and useTerminals", () => {
  it("read their root and the oldest-first list, and follow the stores", async () => {
    const view = await mount(<Probe root="/w" />);
    expect(view.container.textContent).toBe("none|");
    await act(async () => {
      useVcsStore.getState().apply("/w", { kind: "status", status: vcsStatus("/w", { branch: "dev" }) });
      useVcsStore.getState().apply("/x", { kind: "status", status: vcsStatus("/x", { branch: "other" }) });
      useTerminalStore.getState().apply({
        kind: "snapshot",
        terminals: [terminalView(2, { cwd: "/b" }), terminalView(1, { cwd: "/a" })],
      });
    });
    expect(view.container.textContent).toBe("dev|/a,/b");
  });
});
