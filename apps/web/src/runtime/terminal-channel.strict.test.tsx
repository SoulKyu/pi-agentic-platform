// @vitest-environment happy-dom
import { StrictMode, useEffect } from "react";
import { describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { TERMINAL_ID, terminalBed } from "../testing/terminal-bed.ts";
import { flush } from "./testing.ts";

describe("terminal channel under React StrictMode (MC31)", () => {
  it("mount, unmount, mount inside one attach round trip ends with one live stream the pane can use", async () => {
    const bed = terminalBed();
    bed.holdAttaches();
    const { channel } = bed;
    const pane: { input?: (data: Uint8Array) => boolean } = {};
    function Pane() {
      useEffect(() => {
        const handle = channel.open(TERMINAL_ID, bed.sink);
        pane.input = handle.input;
        return () => handle.close();
      }, []);
      return null;
    }
    await mount(
      <StrictMode>
        <Pane />
      </StrictMode>,
    );
    await bed.release();
    await flush();
    expect(bed.called("terminal.attach")).toHaveLength(1);
    expect(bed.called("terminal.detach")).toEqual([]);
    expect(bed.sink.state).toHaveBeenLastCalledWith("live");
    bed.output(1, 0, "ok");
    expect(bed.sink.output).toHaveBeenCalledOnce();
    expect(pane.input?.(new Uint8Array([97]))).toBe(true);
  });
});
