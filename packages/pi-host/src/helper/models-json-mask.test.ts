import { describe, expect, it } from "vitest";
import { MAX_SECRETS, maskModelsJson, unmaskModelsJson } from "./models-json-mask.ts";

const ALL = `{"providers":{"x":{"apiKey":"sk-123","headers":{"Authorization":"Bearer t"},"baseUrl":"https://h"}}}`;
const mask = (text: string) => maskModelsJson(text);
const back = (text: string, from: ReturnType<typeof maskModelsJson>) =>
  unmaskModelsJson(text, from.secrets, from.places);
const roundTrip = (text: string) => {
  const masked = mask(text);
  return back(masked.masked, masked);
};

describe("maskModelsJson (M7R62 masking table)", () => {
  it("masks a key and a header, not the base URL, numbering secrets in document order", () => {
    const { masked, secrets } = mask(ALL);
    expect(masked).toBe(
      `{"providers":{"x":{"apiKey":"<redacted:0>","headers":{"Authorization":"<redacted:1>"},"baseUrl":"https://h"}}}`,
    );
    expect(secrets).toEqual([`"sk-123"`, `"Bearer t"`]);
    expect(masked).not.toContain("sk-123");
    expect(masked).not.toContain("Bearer");
  });

  it.each([
    ["a $NAME reference", `{"apiKey": "$OPENAI_KEY"}`],
    ["a ${NAME} reference", `{"apiKey": "\${K}"}`],
    ["a ! command", `{"apiKey": "!op read x"}`],
    ["a reference inside headers", `{"headers": {"Authorization": "$TOKEN"}}`],
    ["a command inside headers", `{"headers": {"Authorization": "!pass show x"}}`],
  ])("leaves %s as it is", (_name, text) => {
    expect(mask(text)).toEqual({ masked: text, secrets: [], places: [] });
  });

  it.each([
    "apiKey",
    "api_key",
    "api-key",
    "API_KEY",
    "ApiKey",
    "key",
    "KEY",
    "token",
    "Secret",
    "PASSWORD",
    "DB_PWD",
    "passphrase",
    "SESSION_ID",
    "X-Signature",
  ])("masks the key name %s in any case", (name) => {
    expect(mask(`{"${name}": "v1"}`).masked).toBe(`{"${name}": "<redacted:0>"}`);
  });

  it("masks a key spelled with an escape, because the name is decoded", () => {
    expect(mask(`{"api\\u004bey": "v1"}`).masked).toBe(`{"api\\u004bey": "<redacted:0>"}`);
  });

  it("masks inside a nested value and an array under a credential key", () => {
    const text = `{"apiKey": {"a": "s1", "b": ["s2"]}, "headers": [{"x": "s3"}]}`;
    expect(mask(text).secrets).toEqual([`"s1"`, `"s2"`, `"s3"`]);
  });

  it("does not mask the key names themselves nor other fields", () => {
    const text = `{"providers":{"mine":{"models":[{"id":"m"}]},"token":1,"password":true,"note":"hi"}}`;
    expect(mask(text).secrets).toEqual([]);
  });

  it("does not mask a model called like a credential key", () => {
    expect(mask(`{"models":[{"id":"key"}]}`).secrets).toEqual([]);
  });

  describe("comments", () => {
    it("redacts a quoted pair in a line comment, so a commented-out key never reaches the wire", () => {
      const { masked, secrets } = mask(`{\n  // "apiKey": "sk-OLD-KEY"\n  "a": 1\n}`);
      expect(masked).not.toContain("sk-OLD");
      expect(secrets).toHaveLength(1);
      expect(secrets[0]).toContain("sk-OLD-KEY");
    });

    it.each([
      ["an env assignment", `// OPENAI_API_KEY=sk-proj-AAA`],
      ["an export with quotes", `// export ANTHROPIC_API_KEY="sk-ant-BBB"`],
      ["a camelCase key", `// "openaiApiKey": "sk-CCC"`],
      ["a prefixed name", `// my_token: sk-DDD`],
      ["a password", `// db password = hunter2-EEE`],
      ["a passwd", `// passwd: hunter2-FFF`],
      ["an authorization header", `// Authorization: Bearer sk-GGG`],
      ["a bearer", `// bearer sk-HHH`],
      ["a credential", `// credential sk-III`],
      ["a cookie", `// cookie: session-JJJ`],
      ["a secret", `// client_secret = s3cr3t-KKK`],
      ["a name with a trailing space", `// "api key " : "sk-LLL"`],
      ["a block comment", `/* old: apiKey=sk-MMM */`],
      ["a second line of a block comment", `/* note\n   token: sk-NNN\n*/`],
    ])("redacts %s from the credential word to the end of the line", (_name, comment) => {
      const text = `{\n  ${comment}\n  "a": 1\n}`;
      const { masked, secrets } = mask(text);
      expect(masked).not.toMatch(/sk-[A-Z]{3}|hunter2|s3cr3t|session-JJJ/);
      expect(secrets.length).toBeGreaterThan(0);
      expect(roundTrip(text)).toBe(text);
    });

    it.each([
      ["a word glued to the value", `// token_sk-C8glued`],
      ["a value that starts with a bang but is not a command", `// apiKey: !important sk-C9`],
      ["a bang value with more after it", `// api_key = !x sk-C10`],
    ])("redacts from the credential word itself: %s", (_name, comment) => {
      const text = `{\n  ${comment}\n  "a": 1\n}`;
      const { masked, secrets } = mask(text);
      expect(masked).not.toMatch(/sk-C\d+/);
      expect(secrets).toHaveLength(1);
      expect(roundTrip(text)).toBe(text);
    });

    it("cuts right after the credential word, not after the whole identifier", () => {
      expect(mask(`{ // my_token_value: abc\n "a": 1 }`).masked).toBe(
        `{ // my_token"<redacted:0>"\n "a": 1 }`,
      );
    });

    it("keeps a quoted reference or command whole, and nothing that only starts with a bang", () => {
      const kept = `{\n // "apiKey": "!op read x"\n // key = '$A_B'\n "a": 1 }`;
      expect(mask(kept).secrets).toEqual([]);
      expect(mask(`{\n // "apiKey": "!op read x" sk-C11\n "a": 1 }`).secrets).toHaveLength(1);
    });

    it("keeps the block comment closed in the masked text", () => {
      expect(mask(`{ /* token: abc */ "a": 1 }`).masked.endsWith(`*/ "a": 1 }`)).toBe(true);
    });

    it("keeps a reference or a command in a comment", () => {
      const text = `{\n // "apiKey": "$OPENAI_KEY"\n // "apiKey": "!op read x"\n "a": 1 }`;
      expect(mask(text)).toEqual({ masked: text, secrets: [], places: [] });
    });

    it("redacts a literal that follows a kept command in the same comment line (quotes inside the quoted value)", () => {
      const text = `{\n // "apiKey": "!op read x" "sk-abc"\n "a": 1 }`;
      const { masked, secrets } = mask(text);
      expect(masked).not.toContain("sk-abc");
      expect(secrets).toHaveLength(1);
      expect(roundTrip(text)).toBe(text);
    });

    it("leaves a comment with no credential word alone", () => {
      const text = `{\n // the other provider, see below\n "a": 1 }`;
      expect(mask(text)).toEqual({ masked: text, secrets: [], places: [] });
    });

    it("accepts over-masking: a word inside another word is redacted, and restored exactly", () => {
      const text = `{\n // the monkey keyboard\n "a": 1 }`;
      expect(mask(text).secrets).toHaveLength(1);
      expect(roundTrip(text)).toBe(text);
    });

    it("does not treat a // inside a string value as a comment, and keeps masking after it", () => {
      const { masked } = mask(`{"baseUrl": "https://h//v1", "apiKey": "sk-1"}`);
      expect(masked).toBe(`{"baseUrl": "https://h//v1", "apiKey": "<redacted:0>"}`);
    });

    it("masks a key after a comment that holds an unbalanced quote", () => {
      const { masked } = mask(`{ // it's "broken\n "apiKey": "sk-1" }`);
      expect(masked).not.toContain("sk-1");
    });
  });

  describe("credential words are substrings of the normalised name (I4, m9)", () => {
    it.each([
      "openaiApiKey",
      "X-Api-Key",
      "client_secret",
      "accessToken",
      "dbPasswd",
      "Authorization",
      "bearer",
      "myCredentials",
      "Cookie",
      "api key ",
      " apiKey",
      "api_key2",
    ])("masks a value under %s", (name) => {
      expect(mask(`{"${name}": "v1"}`).masked).toBe(`{"${name}": "<redacted:0>"}`);
    });

    it("masks the user name and password in a URL, and not a plain URL", () => {
      expect(mask(`{"baseUrl": "https://u:pw@h/v1"}`).masked).toBe(`{"baseUrl": "<redacted:0>"}`);
      expect(mask(`{"baseUrl": "https://h/v1?a=b@c"}`).secrets).toEqual([]);
    });
  });

  describe("broken text still masks what it can", () => {
    it("masks a credential key even after a missing comma", () => {
      const text = `{"x": {"baseUrl": "https://h" "apiKey": "sk-BROKEN"}}`;
      expect(mask(text).masked).not.toContain("sk-BROKEN");
    });
  });

  describe("escapes", () => {
    it("round-trips an escaped secret byte for byte", () => {
      const text = `{"apiKey": "a\\"b\\\\", "headers": {"x": "q\\u0022r"}}`;
      const masked = mask(text);
      expect(masked.secrets).toEqual([`"a\\"b\\\\"`, `"q\\u0022r"`]);
      expect(masked.masked).not.toContain("a\\");
      expect(back(masked.masked, masked)).toBe(text);
    });

    it("treats an escaped quote before a // as part of the string", () => {
      const text = `{"apiKey": "a\\"//b", "baseUrl": "u"}`;
      expect(mask(text).masked).toBe(`{"apiKey": "<redacted:0>", "baseUrl": "u"}`);
    });
  });

  it.each([
    ALL,
    `{ // c\n "providers": { "m": { "apiKey": "a", "headers": {"h": "b",}, }, }, }\n`,
    `{"apiKey": "k" /* "token": "t" */}`,
    "",
    `{}`,
  ])("mask then unmask of an unchanged text is the original: %s", (text) => {
    expect(roundTrip(text)).toBe(text);
  });

  it("is deterministic", () => {
    expect(mask(ALL)).toEqual(mask(ALL));
  });

  it("refuses a file with more than MAX_SECRETS secrets", () => {
    const text = `{"a": [${Array.from({ length: MAX_SECRETS + 1 }, () => `{"key": "v"}`).join(",")}]}`;
    expect(() => mask(text)).toThrow(RangeError);
  });

  it("throws without quoting the text on an unterminated string", () => {
    expect(() => mask(`{"apiKey": "sk-SECRET`)).toThrowError(/^unterminated string$/);
  });
});

describe("unmaskModelsJson (I1: a secret returns only to the key path it came from)", () => {
  const two = `{"providers":{"a":{"apiKey":"SA","headers":{"Authorization":"HA"},"baseUrl":"https://h"},"b":{"apiKey":"SB","headers":{"X":"HB"}}}}`;
  const refusedAt = (text: string, from: ReturnType<typeof maskModelsJson>) => {
    const result = back(text, from);
    expect(typeof result).toBe("object");
    return (result as { refused: number }).refused;
  };

  it("answers refused, with the offset, for a placeholder the file does not have", () => {
    const text = `{"apiKey": "<redacted:7>"}`;
    expect(unmaskModelsJson(text, [`"a"`, `"b"`], ["[]", "[]"])).toEqual({ refused: text.indexOf('"<') });
  });

  it("refuses a placeholder moved into a plain field, a model name, a base URL or a comment, the original gone", () => {
    const masked = mask(two);
    const freed = masked.masked.replace(`"apiKey":"<redacted:0>"`, `"apiKey":"typed"`);
    for (const [from, to] of [
      [`"baseUrl":"https://h"`, `"baseUrl":"<redacted:0>"`],
      [`"baseUrl":"https://h"`, `"name":"<redacted:0>"`],
      [`"b":{`, `"b":{"models":[{"id":"m","name":"<redacted:0>"}],`],
    ]) {
      const moved = freed.replace(from as string, to as string);
      expect(refusedAt(moved, masked)).toBe(moved.indexOf(`"<redacted:0>"`));
    }
    const inComment = freed.replace(`{"providers"`, `{ // note "<redacted:0>"\n"providers"`);
    expect(refusedAt(inComment, masked)).toBe(inComment.indexOf("// note"));
  });

  it("refuses provider A's key placed in provider B's credential field, and B's header placed in A's", () => {
    const masked = mask(two);
    const swapped = masked.masked
      .replace(`"apiKey":"<redacted:0>"`, `"apiKey":"<redacted:2>"`)
      .replace(`"apiKey":"<redacted:2>","headers":{"X"`, `"apiKey":"<redacted:0>","headers":{"X"`);
    expect(refusedAt(swapped, masked)).toBe(swapped.indexOf(`"<redacted:2>"`));
    const header = masked.masked
      .replace(`"Authorization":"<redacted:1>"`, `"Authorization":"<redacted:3>"`)
      .replace(`"X":"<redacted:3>"`, `"X":"<redacted:1>"`);
    expect(refusedAt(header, masked)).toBe(header.indexOf(`"<redacted:3>"`));
  });

  it("refuses a placeholder used twice, even twice at the same key path", () => {
    const masked = mask(`{"apiKey":"S1","apiKey":"S2"}`);
    const twice = masked.masked.replace(`"<redacted:1>"`, `"<redacted:0>"`);
    expect(refusedAt(twice, masked)).toBe(twice.lastIndexOf(`"<redacted:0>"`));
  });

  it("restores at the same key path after the text around it was edited", () => {
    const masked = mask(two);
    const edited = masked.masked.replace(`"https://h"`, `"https://other"`).replace(`"<redacted:3>"`, `"new"`);
    expect(back(edited, masked)).toBe(
      `{"providers":{"a":{"apiKey":"SA","headers":{"Authorization":"HA"},"baseUrl":"https://other"},"b":{"apiKey":"SB","headers":{"X":"new"}}}}`,
    );
  });

  it("restores after the object was reordered, since the path is by key", () => {
    const masked = mask(`{"p":{"apiKey":"S1","baseUrl":"u"}}`);
    expect(back(`{"p":{"baseUrl":"u","apiKey":"<redacted:0>"}}`, masked)).toBe(
      `{"p":{"baseUrl":"u","apiKey":"S1"}}`,
    );
  });

  it("restores a placeholder in the comment it came from, and refuses it when the comment would show it", () => {
    const masked = mask(`{ // token: t9\n "a": 1 }`);
    expect(back(masked.masked, masked)).toBe(`{ // token: t9\n "a": 1 }`);
    const shown = masked.masked.replace(/token.*"<redacted:0>"/, `a note "<redacted:0>"`);
    expect(typeof back(shown, masked)).toBe("object");
  });

  it("does not restore a placeholder used as a key, a longer string, or with spaces", () => {
    const masked = mask(`{"apiKey":"S"}`);
    for (const text of [
      `{"<redacted:0>": 1}`,
      `{"a": "x<redacted:0>"}`,
      `{"a": "<redacted:0> "}`,
      `{"a": "<redacted:00000>"}`,
    ])
      expect(back(text, masked)).toBe(text);
  });

  it("refuses a placeholder used twice in comments", () => {
    const masked = mask(`{ // token: t9\n // token: t8\n "a": 1 }`);
    expect(masked.secrets).toHaveLength(2);
    const twice = masked.masked.replace(`"<redacted:1>"`, `"<redacted:0>"`);
    expect(refusedAt(twice, masked)).toBe(twice.lastIndexOf("// token"));
  });

  it("stops at the cap when the text after the last secret is what overflows", () => {
    const text = `{"apiKey":"<redacted:0>","a":"${"x".repeat(500)}"}`;
    expect(() => unmaskModelsJson(text, [`"S"`], ['["apiKey"]'], 100)).toThrow(RangeError);
    expect(unmaskModelsJson(text, [`"S"`], ['["apiKey"]'], 100_000)).toContain(`"apiKey":"S"`);
  });

  it("stops building as soon as the cap is passed, not after the last placeholder", () => {
    const reads: number[] = [];
    const secrets = new Proxy([`"${"x".repeat(200)}"`, `"y"`, `"z"`], {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads.push(Number(key));
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const text = `{"a":"<redacted:0>","b":"<redacted:1>","c":"<redacted:2>"}`;
    expect(() => unmaskModelsJson(text, secrets, ['["a"]', '["b"]', '["c"]'], 100)).toThrow(RangeError);
    expect(Math.max(...reads)).toBe(0);
  });

  it("stops growing past the cap: a placeholder repeated with a huge secret is refused, not built", () => {
    const masked = { masked: "", secrets: [`"${"x".repeat(400_000)}"`], places: ['["a"]'] };
    const text = `{"a":"<redacted:0>"}`;
    expect(() => unmaskModelsJson(text, masked.secrets, masked.places, 100_000)).toThrow(RangeError);
  });
});
