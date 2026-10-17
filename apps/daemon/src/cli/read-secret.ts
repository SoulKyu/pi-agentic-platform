import { StringDecoder } from "node:string_decoder";
import { CliError, type CliIo } from "./open-home.ts";

const MAX_CHARACTERS = 1024;
const MAX_LINE_BYTES = 1024;
const CTRL_C = "\u0003";
const ESCAPE = "\u001b";

type Source = Pick<CliIo, "stdin" | "stdout">;

/**
 * Reads a password (`noun` renames it in the messages, for example "passphrase"). On a terminal: raw mode, nothing echoed, characters until Enter, Backspace removes one code point,
 * at most 1 024 characters; Ctrl-C ends with exit code 130. Otherwise (or with `line`): the first line of standard
 * input, at most 1 024 bytes. The terminal is restored on every path, and the messages are fixed: a stream error's text
 * is never shown. The secret is not written anywhere by this function.
 */
export function readSecret(
  io: Source,
  prompt: string,
  options: { line?: boolean; noun?: string } = {},
): Promise<string> {
  const noun = options.noun ?? "password";
  const TOO_LONG = `the ${noun} is too long`;
  const NONE = `no ${noun} on standard input`;
  const { stdin } = io;
  const raw = stdin.isTTY === true && options.line !== true && typeof stdin.setRawMode === "function";
  if (raw) io.stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const decoder = new StringDecoder("utf8");
    const typed: string[] = [];
    let skipping = false;
    let bytes = 0;
    let text = "";

    const done = (finish: () => void) => {
      if (finished) return;
      finished = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      stdin.removeListener("end", onClose);
      stdin.removeListener("close", onClose);
      try {
        if (raw) stdin.setRawMode?.(false);
      } finally {
        stdin.pause();
        if (raw) io.stdout.write("\n");
        finish();
      }
    };
    const fail = (message: string, code = 1) => done(() => reject(new CliError(message, code)));
    const onError = () => fail(`cannot read the ${noun}`);
    const onEnd = () => fail(NONE);

    const onRawData = (chunk: Buffer | string) => {
      for (const character of typeof chunk === "string" ? chunk : decoder.write(chunk)) {
        if (finished) return;
        if (skipping) {
          // An escape sequence (an arrow key, a paste of one) ends on a letter or `~`.
          if (/[A-Za-z~]/.test(character)) skipping = false;
          continue;
        }
        if (character === CTRL_C) return fail("interrupted", 130);
        if (character === "\r" || character === "\n") return done(() => resolve(typed.join("")));
        if (character === ESCAPE) skipping = true;
        else if (character === "\u007f" || character === "\b") typed.pop();
        else if (character >= " ") typed.push(character);
        if (typed.length > MAX_CHARACTERS) return fail(TOO_LONG);
      }
    };
    const onLineData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const newline = buffer.indexOf(0x0a);
      const piece = newline === -1 ? buffer : buffer.subarray(0, newline);
      bytes += piece.length;
      if (bytes > MAX_LINE_BYTES + 1) return fail(TOO_LONG);
      text += decoder.write(piece);
      if (newline === -1) return;
      text += decoder.end();
      const line = text.endsWith("\r") ? text.slice(0, -1) : text;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return fail(TOO_LONG);
      done(() => resolve(line));
    };
    const onData = raw ? onRawData : onLineData;
    // Without a newline the first line is whatever came before the end of input (`printf pw | pap …`), unless nothing came.
    const onLineEnd = () => {
      const line = (text + decoder.end()).replace(/\r$/, "");
      if (bytes === 0) return fail(NONE);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return fail(TOO_LONG);
      done(() => resolve(line));
    };

    const onClose = raw ? onEnd : onLineEnd;
    stdin.on("data", onData);
    stdin.on("error", onError);
    stdin.on("end", onClose);
    stdin.on("close", onClose);
    if (raw) stdin.setRawMode?.(true);
    stdin.resume();
  });
}
