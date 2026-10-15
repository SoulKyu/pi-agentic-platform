import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed-parse.ts";

const NOT_A_FEED = { ok: false, code: "not_a_feed" } as const;
const ONE_MIB = 1024 * 1024;

function timed(xml: string): { result: ReturnType<typeof parseFeed>; ms: number } {
  const start = performance.now();
  const result = parseFeed(xml);
  return { result, ms: performance.now() - start };
}

describe("a hostile feed (M10R75)", () => {
  it("refuses a DOCTYPE with entities and expands nothing", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
<rss><channel><item><title>&lol2;</title></item></channel></rss>`;
    expect(parseFeed(xml)).toEqual(NOT_A_FEED);
  });

  it.each([
    ["a DOCTYPE", `<!DOCTYPE rss><rss><channel><item><title>x</title></item></channel></rss>`],
    ["a lower-case doctype", `<!doctype rss><rss><channel><item><title>x</title></item></channel></rss>`],
    ["a spaced doctype", `<! DOCTYPE rss><rss><channel><item><title>x</title></item></channel></rss>`],
    [
      "an ENTITY after the root",
      `<rss><channel><item><title>x</title></item></channel></rss><!ENTITY a "b">`,
    ],
    [
      "a DOCTYPE inside a comment",
      `<rss><!-- <!DOCTYPE x> --><channel><item><title>x</title></item></channel></rss>`,
    ],
    [
      "a DOCTYPE inside CDATA",
      `<rss><channel><item><title><![CDATA[<!DOCTYPE x>]]></title></item></channel></rss>`,
    ],
  ])("refuses %s", (_name, xml) => expect(parseFeed(xml)).toEqual(NOT_A_FEED));

  it("never expands an entity it does not know, even one an attacker defines elsewhere", () => {
    const parsed = parseFeed(`<rss><channel><item><title>&lol;&xxe;</title></item></channel></rss>`);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.entries[0]?.title).toBe("&lol;&xxe;");
  });

  it("does not decode twice: a decoded ampersand never starts a new entity", () => {
    const parsed = parseFeed(`<rss><channel><item><title>&amp;lt;b&amp;gt;</title></item></channel></rss>`);
    if (!parsed.ok) throw new Error("not a feed");
    expect(parsed.entries[0]?.title).toBe("&lt;b&gt;");
  });

  it("refuses garbage", () => {
    for (const text of [
      "",
      "   ",
      "just some text",
      '{"a":1}',
      "<",
      "<<<<",
      "<?xml?>",
      "<rss",
      "\\u0000\\u0001",
    ])
      expect(parseFeed(text), JSON.stringify(text)).toEqual(NOT_A_FEED);
  });

  it("refuses a document nested deeper than the cap", () => {
    const deep = `<rss>${"<a>".repeat(200)}${"</a>".repeat(200)}</rss>`;
    expect(parseFeed(deep)).toEqual(NOT_A_FEED);
  });

  it("refuses a document with more nodes than the cap", () => {
    const flat = `<rss><channel><item><title>x</title>${"<a/>".repeat(60_000)}</item></channel></rss>`;
    expect(parseFeed(flat)).toEqual(NOT_A_FEED);
  });

  it("parses 1 MiB of nested unclosed tags within 200 ms", () => {
    const { result, ms } = timed("<a>".repeat(ONE_MIB / 3));
    expect(result).toEqual(NOT_A_FEED);
    expect(ms).toBeLessThan(200);
  });

  it.each([
    ["angle brackets", "<".repeat(ONE_MIB)],
    ["an unclosed tag", `<rss><channel><item><title${" x=".repeat(ONE_MIB / 3)}`],
    ["an unclosed comment", `<rss><!--${"-".repeat(ONE_MIB)}`],
    ["an unclosed CDATA", `<rss><channel><item><title><![CDATA[${"]".repeat(ONE_MIB)}`],
    ["ampersands", `<rss><channel><item><title>${"&#".repeat(ONE_MIB / 2)}</title></item></channel></rss>`],
    ["attributes", `<rss><channel><item><link ${'a="1" '.repeat(ONE_MIB / 6)}/></item></channel></rss>`],
    [
      "tags in a summary",
      `<rss><channel><item><title>t</title><description>${"<".repeat(ONE_MIB)}</description></item></channel></rss>`,
    ],
    ["close tags", "</a>".repeat(ONE_MIB / 4)],
  ])("handles 1 MiB of %s within 200 ms", (_name, xml) => {
    const { ms } = timed(xml);
    expect(ms).toBeLessThan(200);
  });

  it("clips a huge summary without reading all of it", () => {
    const xml = `<rss><channel><item><title>t</title><description>${"word ".repeat(ONE_MIB / 5)}</description></item></channel></rss>`;
    const { result, ms } = timed(xml);
    expect(ms).toBeLessThan(200);
    if (!result.ok) throw new Error("not a feed");
    expect(result.entries[0]?.summary).toHaveLength(1024);
  });
});
