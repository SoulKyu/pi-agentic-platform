import type { HandlerTable } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceiptStore } from "../../kernel/db/receipts.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { makeModuleBed, REQUEST_ID } from "./testing/module-bed.ts";

let bed: ReturnType<typeof makeModuleBed>;
afterEach(() => bed.cleanup());

/** The real dispatcher with the receipt store of a database that is read-only (spec C 3.2). */
function readOnlyDispatch() {
  bed = makeModuleBed();
  const receipts: ReceiptStore = {
    find: () => null,
    save: () => {},
    purge: () => 0,
    readOnly: true,
  };
  const write = vi.fn(async () => ({}));
  const handlers = { ...bed.rpc, "files.write": write } as unknown as HandlerTable;
  const dispatch = createDispatcher({ handlers, receipts, logger: silentLogger });
  return { dispatch, write };
}

describe("a read-only database (RT-09)", () => {
  it("still creates, attaches, resizes, detaches and closes terminals", async () => {
    const { dispatch } = readOnlyDispatch();
    const ctx = bed.ctxOf();
    const created = await dispatch(
      {
        id: 1,
        method: "terminal.create",
        params: { requestId: REQUEST_ID, cwd: bed.project, cols: 80, rows: 24 },
      },
      ctx,
    );
    expect(created).toMatchObject({ ok: true, result: { terminalId: expect.any(String) } });
    const terminalId = (created as { result: { terminalId: string } }).result.terminalId;

    const attached = await dispatch({ id: 2, method: "terminal.attach", params: { terminalId } }, ctx);
    expect(attached).toMatchObject({ ok: true, result: { status: "running" } });
    const streamId = (attached as { result: { streamId: number } }).result.streamId;

    expect(
      await dispatch({ id: 3, method: "terminal.resize", params: { terminalId, cols: 90, rows: 30 } }, ctx),
    ).toEqual({
      id: 3,
      ok: true,
      result: { ok: true },
    });
    expect(await dispatch({ id: 4, method: "terminal.detach", params: { streamId } }, ctx)).toMatchObject({
      ok: true,
    });
    expect(await dispatch({ id: 5, method: "terminal.close", params: { terminalId } }, ctx)).toMatchObject({
      ok: true,
    });
    expect(bed.kill).toHaveBeenCalledTimes(1);
  });

  it("refuses a file write before its handler", async () => {
    const { dispatch, write } = readOnlyDispatch();
    const reply = await dispatch(
      {
        id: 1,
        method: "files.write",
        params: { path: `${bed.project}/a.txt`, text: "x", baseEtag: null },
        commandId: "cmd-read-only-1",
      },
      bed.ctxOf(),
    );
    expect(reply).toEqual({ id: 1, ok: false, error: { code: "read_only" } });
    expect(write).not.toHaveBeenCalled();
  });
});
