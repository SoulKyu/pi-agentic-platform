import { describe, expect, it } from "vitest";
import { createRedactor, NO_REDACTOR } from "./policy/redact.ts";
import { createStreamRedactor, takeStreamCount } from "./redact-stream.ts";

const SECRET = "pap-test-secret-0a1b2c3d";
const redactor = createRedactor({ entries: [{ name: "TOKEN", value: SECRET }] });
const run = (chunks: Array<string | Buffer>, current = () => redactor) => {
  const stream = createStreamRedactor(current);
  const out = chunks.map((chunk) =>
    stream.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString(),
  );
  return { emitted: out.join(""), tail: stream.flush().toString(), all: [...out, stream.flush().toString()] };
};

describe("createStreamRedactor (the output Pi writes to its full-output file)", () => {
  it("replaces a value that arrives whole, with the text around it", () => {
    const { emitted, tail } = run([`before ${SECRET} after\n`]);
    expect(emitted + tail).toBe("before [SECRET:TOKEN] after\n");
  });

  it("replaces a value split across any chunk boundary, byte by byte", () => {
    const text = `x=${SECRET};y=${SECRET}\n`;
    const { emitted, tail } = run([...text].map((char) => char));
    expect(emitted + tail).toBe("x=[SECRET:TOKEN];y=[SECRET:TOKEN]\n");
    expect((emitted + tail).includes(SECRET)).toBe(false);
  });

  it("never emits a prefix of a value that is still being received", () => {
    const stream = createStreamRedactor(() => redactor);
    const first = stream.push(Buffer.from(`log ${SECRET.slice(0, 12)}`)).toString();
    expect(first).not.toContain(SECRET.slice(0, 5));
    const rest =
      stream.push(Buffer.from(`${SECRET.slice(12)} done\n`)).toString() + stream.flush().toString();
    expect(first + rest).toBe("log [SECRET:TOKEN] done\n");
  });

  it("passes everything through at once when no secret is known", () => {
    const stream = createStreamRedactor(() => NO_REDACTOR);
    expect(stream.push(Buffer.from("plain\n")).toString()).toBe("plain\n");
    expect(stream.flush().length).toBe(0);
  });

  it("keeps a character split across two chunks whole", () => {
    const bytes = Buffer.from("café \u{1f600}\n");
    const { emitted, tail } = run([...bytes].map((byte) => Buffer.from([byte])));
    expect(emitted + tail).toBe("café \u{1f600}\n");
  });

  it("finds a value in its JSON-escaped form too", () => {
    const quoted = createRedactor({ entries: [{ name: "Q", value: 'pap-"quoted"-value-1' }] });
    const { emitted, tail } = run(['{"v":"pap-\\"quoted\\"-value-1"}'], () => quoted);
    expect(emitted + tail).toBe('{"v":"[SECRET:Q]"}');
  });

  it("holds back nothing for text that starts no value, so a long output keeps flowing", () => {
    const stream = createStreamRedactor(() => redactor);
    const line = `${"a".repeat(100)}\n`;
    let emitted = 0;
    for (let i = 0; i < 50; i++) emitted += stream.push(Buffer.from(line)).length;
    expect(emitted).toBe(50 * line.length);
    expect(stream.flush().length).toBe(0);
  });

  it("holds back exactly the tail that is a prefix of a value", () => {
    const stream = createStreamRedactor(() => redactor);
    expect(stream.pushText(`ab ${SECRET.slice(0, 9)}`)).toBe("ab ");
    expect(stream.pushText("!")).toBe(`${SECRET.slice(0, 9)}!`);
  });

  it("reads the secrets again at each chunk: a value that arrives mid-command is covered from then on", () => {
    let current = NO_REDACTOR as typeof redactor;
    const stream = createStreamRedactor(() => current);
    const first = stream.push(Buffer.from("one\n")).toString();
    current = redactor;
    const second = stream.push(Buffer.from(`two ${SECRET}\n`)).toString() + stream.flush().toString();
    expect(first + second).toBe("one\ntwo [SECRET:TOKEN]\n");
  });

  it("counts what it replaced, including a value cut by a chunk boundary", () => {
    const stream = createStreamRedactor(() => redactor);
    stream.push(Buffer.from(`${SECRET} and ${SECRET.slice(0, 10)}`));
    stream.push(Buffer.from(SECRET.slice(10)));
    stream.flush();
    expect(stream.count()).toBe(2);
  });

  it("works on text for the deltas of a message, with the same hold-back", () => {
    const stream = createStreamRedactor(() => redactor);
    const out = [...`say ${SECRET} now`].map((char) => stream.pushText(char)).join("") + stream.flushText();
    expect(out).toBe("say [SECRET:TOKEN] now");
    expect(takeStreamCount("never-set")).toBe(0);
  });
});
