import { describe, expect, it } from "vitest";
import { createRedactor } from "./policy/redact.ts";
import { redactStdio } from "./redact-stdio.ts";

const redactor = createRedactor({ entries: [{ name: "GH", value: "ghp_testsecret_01" }] });

function fakeStream() {
  const written: Array<string | Uint8Array> = [];
  const callbacks: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean {
      written.push(chunk);
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") {
        (done as () => void)();
        callbacks.push("called");
      }
      return true;
    },
  };
  return { stream, written, callbacks };
}

describe("redactStdio", () => {
  it("redacts strings and buffers written to the stream, and keeps callbacks", () => {
    const { stream, written, callbacks } = fakeStream();
    redactStdio(stream, () => redactor);
    stream.write("token ghp_testsecret_01\n");
    stream.write(Buffer.from("buf ghp_testsecret_01"), () => {});
    stream.write("plain", "utf8", () => {});
    expect(written.map(String)).toEqual(["token [SECRET:GH]\n", "buf [SECRET:GH]", "plain"]);
    expect(callbacks).toEqual(["called", "called"]);
  });

  it("passes a chunk without a secret through as it is, the very same object", () => {
    const { stream, written } = fakeStream();
    redactStdio(stream, () => redactor);
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    stream.write(bytes);
    expect(written[0]).toBe(bytes);
  });

  it("drops a chunk it cannot check, with a fixed line, and still answers the callback", () => {
    const { stream, written, callbacks } = fakeStream();
    redactStdio(stream, () => {
      throw new Error("ghp_testsecret_01");
    });
    stream.write("ghp_testsecret_01", () => {});
    expect(written).toEqual(["pi-host: output could not be checked for secrets: dropped\n"]);
    expect(callbacks).toEqual(["called"]);
  });
});
