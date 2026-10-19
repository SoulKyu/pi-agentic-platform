import { describe, expect, it } from "vitest";
import { hasDuplicateTopLevelKey } from "./json-keys.ts";
import { modelOf } from "./routes.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-last-wins: `modelOf` stops calling `hasDuplicateTopLevelKey` -> "refuses a body with two model keys" fails.
 *  - M-no-unescape: the scanner compares the raw key text instead of the decoded key -> the escaped-spelling case fails.
 *  - M-nested: the scanner counts keys at every depth -> "a nested model is not a duplicate" fails.
 */
const has = (text: string): boolean => hasDuplicateTopLevelKey(Buffer.from(text), "model");

describe("hasDuplicateTopLevelKey", () => {
  it("sees two model keys", () => {
    expect(has('{"model":"a","model":"b"}')).toBe(true);
    expect(has('{ "model" : "a" ,\n "x": [1, {"y": 2}], "model" :\t"b" }')).toBe(true);
  });

  it("sees a key spelled with an escape (M-no-unescape)", () => {
    expect(has('{"model":"a","mo\\u0064el":"b"}')).toBe(true);
    expect(has('{"m\\u006fdel":"a","model":"b"}')).toBe(true);
  });

  it("does not count a nested model, a model in a string or a single key (M-nested)", () => {
    expect(has('{"model":"a","x":{"p":1,"model":"b"},"y":[{"q":2,"model":"c"}]}')).toBe(false);
    expect(has('{"model":"a","text":"\\"model\\": 1, \\"model\\": 2"}')).toBe(false);
    expect(has('{"model":"a"}')).toBe(false);
    expect(has("{}")).toBe(false);
    expect(has('{"models":"a","model":"b","modelx":"c"}')).toBe(false);
  });

  it("is not fooled by braces and quotes inside strings", () => {
    expect(has('{"a":"}{\\"","model":"x","b":"\\\\","model":"y"}')).toBe(true);
    expect(has('{"a":"}{\\"","model":"x","b":"\\\\"}')).toBe(false);
  });

  it("answers false for what is not an object", () => {
    expect(has("[1,2]")).toBe(false);
    expect(has('"model"')).toBe(false);
    expect(has("")).toBe(false);
  });
});

describe("modelOf and a duplicate model key (M-last-wins)", () => {
  it("refuses a body with two model keys: JSON.parse would keep the last, the policy must not", () => {
    const body = Buffer.from('{"model":"glm-4.6","model":"other-model","messages":[]}');
    expect(JSON.parse(body.toString()).model).toBe("other-model");
    expect(modelOf("openai-completions", "/chat/completions", body)).toBeNull();
  });

  it("still reads a body with one", () => {
    expect(modelOf("openai-completions", "/chat/completions", Buffer.from('{"model":"glm-4.6"}'))).toBe(
      "glm-4.6",
    );
  });
});
