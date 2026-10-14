import { describe, expect, it } from "vitest";
import { connectionBed as setup } from "./testing.ts";

describe("connection binary frames (M8R68)", () => {
  it("asks the socket for arraybuffers", () => {
    const { connection, latest } = setup();
    connection.start();
    expect(latest().binaryType).toBe("arraybuffer");
  });

  it("hands an ArrayBuffer message to onBinary and to no JSON listener", () => {
    const { connection, hello, latest } = setup();
    const frames: unknown[] = [];
    const binary: ArrayBuffer[] = [];
    connection.onFrame((frame) => frames.push(frame));
    connection.onBinary((data) => binary.push(data));
    connection.start();
    hello();
    latest().receiveBinary(new Uint8Array([0x70, 1, 2]));
    expect(frames).toEqual([]);
    expect(binary).toHaveLength(1);
    expect([...new Uint8Array(binary[0] as ArrayBuffer)]).toEqual([0x70, 1, 2]);
  });

  it("still hands a string to onFrame and none to onBinary", () => {
    const { connection, hello, latest } = setup();
    const frames: unknown[] = [];
    const binary: ArrayBuffer[] = [];
    connection.onFrame((frame) => frames.push(frame));
    connection.onBinary((data) => binary.push(data));
    connection.start();
    hello();
    latest().receive({ id: 1, ok: true, result: {} });
    expect(frames).toEqual([{ id: 1, ok: true, result: {} }]);
    expect(binary).toEqual([]);
  });

  it("ignores a binary message before the hello (never JSON-parsed, never delivered)", () => {
    const { connection, latest } = setup();
    const binary: ArrayBuffer[] = [];
    connection.onBinary((data) => binary.push(data));
    connection.start();
    latest().receiveBinary(new Uint8Array([1]));
    expect(binary).toEqual([]);
    expect(connection.state).toBe("connecting");
  });

  it("sendBinary is false until open, then reaches the socket as bytes", () => {
    const { connection, hello, latest } = setup();
    expect(connection.sendBinary(new Uint8Array([1]))).toBe(false);
    connection.start();
    expect(connection.sendBinary(new Uint8Array([1]))).toBe(false);
    hello();
    expect(connection.sendBinary(new Uint8Array([7, 8]))).toBe(true);
    expect(latest().sentBinary.map((bytes) => [...bytes])).toEqual([[7, 8]]);
  });

  it("a binary message keeps the dead-peer timer fed", () => {
    const { connection, hello, latest, advance } = setup();
    connection.start();
    hello();
    advance(14_000);
    latest().receiveBinary(new Uint8Array([1]));
    advance(14_000);
    expect(connection.state).toBe("open");
  });
});
