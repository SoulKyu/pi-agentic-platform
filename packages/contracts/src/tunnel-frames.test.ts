import { describe, expect, it } from "vitest";
import { Hello } from "./agents-vm.ts";
import { TUNNEL_FRAME_BYTES, TUNNEL_WINDOW_BYTES, TunnelFrame } from "./tunnel-frames.ts";

const hex = (n: number, ch = "a"): string => ch.repeat(n);
const hello = {
  type: "hello",
  role: "tunnel",
  box: { kind: "agent", id: "helper-1a2b" },
  launchId: hex(32),
  token: hex(64),
  protocol: 4,
  imageTag: `pap-agent-agent-${hex(64, "b")}`,
  slot: hex(32, "c"),
};
const b64 = (bytes: number): string => Buffer.alloc(bytes, 1).toString("base64");

describe("tunnel hello", () => {
  it("parses through Hello at protocol 4", () => {
    expect(Hello.safeParse(hello).success).toBe(true);
    expect(Hello.parse(hello)).toMatchObject({ role: "tunnel", slot: hex(32, "c") });
  });

  it("refuses protocol 3, no slot, a short slot, an extra key and a short token", () => {
    expect(Hello.safeParse({ ...hello, protocol: 3 }).success).toBe(false);
    expect(Hello.safeParse({ ...hello, slot: undefined }).success).toBe(false);
    expect(Hello.safeParse({ ...hello, slot: hex(31) }).success).toBe(false);
    expect(Hello.safeParse({ ...hello, extra: 1 }).success).toBe(false);
    expect(Hello.safeParse({ ...hello, token: hex(63) }).success).toBe(false);
  });
});

describe("tunnel frames", () => {
  it("states the window and the frame size", () => {
    expect(TUNNEL_WINDOW_BYTES).toBe(1024 * 1024);
    expect(TUNNEL_FRAME_BYTES).toBe(64 * 1024);
  });

  it("accepts data from 1 byte to 64 KiB, an ack and an end", () => {
    for (const size of [1, 2, 3, 100, TUNNEL_FRAME_BYTES]) {
      expect(TunnelFrame.safeParse({ type: "tunnel_data", data: b64(size) }).success, String(size)).toBe(
        true,
      );
    }
    expect(TunnelFrame.safeParse({ type: "tunnel_ack", bytes: 0 }).success).toBe(true);
    expect(TunnelFrame.safeParse({ type: "tunnel_ack", bytes: 123_456 }).success).toBe(true);
    expect(TunnelFrame.safeParse({ type: "tunnel_end" }).success).toBe(true);
  });

  it("refuses empty data, 64 KiB + 1, non-base64, a bad ack, an extra key and another type", () => {
    const data = (text: string) => TunnelFrame.safeParse({ type: "tunnel_data", data: text }).success;
    expect(data("")).toBe(false);
    expect(data(b64(TUNNEL_FRAME_BYTES + 1))).toBe(false);
    expect(data("not base64!")).toBe(false);
    expect(data("abc")).toBe(false);
    expect(TunnelFrame.safeParse({ type: "tunnel_data", data: b64(3), extra: 1 }).success).toBe(false);
    for (const bytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(TunnelFrame.safeParse({ type: "tunnel_ack", bytes }).success, String(bytes)).toBe(false);
    }
    expect(TunnelFrame.safeParse({ type: "tunnel_end", extra: 1 }).success).toBe(false);
    for (const type of ["ping", "pong", "data", "tunnel_open"]) {
      expect(TunnelFrame.safeParse({ type }).success, type).toBe(false);
    }
  });
});
