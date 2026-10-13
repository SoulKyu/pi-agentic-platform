import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CliError } from "./open-home.ts";
import { readSecret } from "./read-secret.ts";
import { fakeTty } from "./testing/fake-tty.ts";

const quiet = () => {
  const out: string[] = [];
  return { stdout: { write: (text: string) => out.push(text) }, out };
};
const plain = (text: string, isTTY = false) =>
  Object.assign(Readable.from(text === "" ? [] : [Buffer.from(text)]), { isTTY });

describe("readSecret on a terminal", () => {
  it("collects characters until Enter, Backspace removes one code point, nothing is echoed", async () => {
    const tty = fakeTty();
    const { stdout, out } = quiet();
    const pending = readSecret({ stdin: tty.stdin, stdout }, "Password: ");
    tty.press("a");
    tty.press("b\u{1F600}");
    tty.press("\u007f");
    tty.press("\u007f");
    tty.press("c");
    tty.press("\r");
    expect(await pending).toBe("ac");
    expect(out.join("")).toBe("Password: \n");
    expect(tty.modes).toEqual([true, false]);
    expect(tty.listeners()).toBe(0);
  });

  it("ignores escape sequences and other control characters", async () => {
    const tty = fakeTty();
    const pending = readSecret({ stdin: tty.stdin, stdout: quiet().stdout }, "p");
    tty.press("a\u001b[Ab\u0001\tc\n");
    expect(await pending).toBe("abc");
  });

  it("ends on Ctrl-C with exit code 130 and the terminal restored", async () => {
    const tty = fakeTty();
    const pending = readSecret({ stdin: tty.stdin, stdout: quiet().stdout }, "p");
    tty.press("ab\u0003");
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(130);
    expect(tty.modes).toEqual([true, false]);
    expect(tty.listeners()).toBe(0);
  });

  it("restores the terminal when the stream fails mid-prompt, without leaking the error text", async () => {
    const tty = fakeTty();
    const pending = readSecret({ stdin: tty.stdin, stdout: quiet().stdout }, "p");
    tty.press("ab");
    tty.fail(new Error("secret-ish detail"));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe("cannot read the password");
    expect((error as CliError).exitCode).toBe(1);
    expect(tty.modes).toEqual([true, false]);
    expect(tty.listeners()).toBe(0);
  });

  it("accepts 1 024 characters and refuses 1 025, restoring the terminal", async () => {
    const ok = fakeTty();
    const accepted = readSecret({ stdin: ok.stdin, stdout: quiet().stdout }, "p");
    ok.press(`${"x".repeat(1024)}\r`);
    expect(await accepted).toBe("x".repeat(1024));

    const tty = fakeTty();
    const pending = readSecret({ stdin: tty.stdin, stdout: quiet().stdout }, "p");
    tty.press("x".repeat(1025));
    await expect(pending).rejects.toThrow("the password is too long");
    expect(tty.modes).toEqual([true, false]);
  });

  it("ends with an error when the terminal closes before Enter", async () => {
    const tty = fakeTty();
    const pending = readSecret({ stdin: tty.stdin, stdout: quiet().stdout }, "p");
    tty.press("ab");
    (tty.stdin as unknown as { emit(name: string): void }).emit("end");
    await expect(pending).rejects.toThrow("no password on standard input");
    expect(tty.modes).toEqual([true, false]);
  });
});

describe("readSecret on standard input", () => {
  it("returns the first line, writes no prompt", async () => {
    const { stdout, out } = quiet();
    expect(await readSecret({ stdin: plain("pw\nrest"), stdout }, "Password: ")).toBe("pw");
    expect(out).toEqual([]);
  });

  it("strips a carriage return and accepts a last line without a newline", async () => {
    expect(await readSecret({ stdin: plain("pw\r\nrest"), stdout: quiet().stdout }, "p")).toBe("pw");
    expect(await readSecret({ stdin: plain("last"), stdout: quiet().stdout }, "p")).toBe("last");
  });

  it("refuses an empty input", async () => {
    await expect(readSecret({ stdin: plain(""), stdout: quiet().stdout }, "p")).rejects.toThrow(
      "no password on standard input",
    );
  });

  it("accepts 1 024 bytes on the first line and refuses 1 025, even split across chunks", async () => {
    const exact = "x".repeat(1024);
    expect(await readSecret({ stdin: plain(`${exact}\n`), stdout: quiet().stdout }, "p")).toBe(exact);
    const chunks = Object.assign(Readable.from(["x".repeat(600), "x".repeat(425), "\n"]), { isTTY: false });
    await expect(readSecret({ stdin: chunks, stdout: quiet().stdout }, "p")).rejects.toThrow(
      "the password is too long",
    );
  });

  it("reads a line from a terminal when asked to (--password-stdin)", async () => {
    const tty = fakeTty();
    const pending = readSecret({ stdin: tty.stdin, stdout: quiet().stdout }, "p", { line: true });
    tty.press("pw\nrest");
    expect(await pending).toBe("pw");
    expect(tty.modes).toEqual([]);
  });

  it("does not leak a stream error", async () => {
    const broken = Object.assign(
      new Readable({
        read() {
          this.destroy(new Error("detail"));
        },
      }),
      { isTTY: false },
    );
    await expect(readSecret({ stdin: broken, stdout: quiet().stdout }, "p")).rejects.toThrow(
      "cannot read the password",
    );
  });
});
