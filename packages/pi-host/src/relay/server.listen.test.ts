import http from "node:http";
import { describe, expect, it } from "vitest";
import { listenOn, parseListen } from "./server.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-wildcard: accept 0.0.0.0 or :: in `parseListen` or `listenOn` -> the refusal cases fail.
 */
describe("parseListen", () => {
  it("accepts the bridge address and loopback", () => {
    expect(parseListen("10.213.0.1:7842")).toEqual({ host: "10.213.0.1", port: 7842 });
    expect(parseListen("127.0.0.1:0")).toEqual({ host: "127.0.0.1", port: 0 });
  });

  it("refuses a wildcard address and anything but those two (M-wildcard)", () => {
    for (const text of [
      "0.0.0.0:7842",
      "0.0.0.0:0",
      "::",
      "[::]:7842",
      "::0",
      "[::0]:1",
      ":7842",
      "7842",
      "",
      "localhost:1",
      "10.213.0.2:7842",
      "192.168.1.5:7842",
      "127.0.0.1",
      "127.0.0.1:70000",
      "127.0.0.1:-1",
      "127.0.0.1:1x",
      "[::1]:7842",
      "127.0.0.1:7842:1",
    ])
      expect(() => parseListen(text), text).toThrow(RangeError);
  });

  it("never listens on a wildcard: listenOn refuses it", async () => {
    const server = http.createServer();
    await expect(listenOn(server, "0.0.0.0", 0)).rejects.toThrow(RangeError);
    await expect(listenOn(server, "::", 0)).rejects.toThrow(RangeError);
    expect(server.listening).toBe(false);
  });
});
