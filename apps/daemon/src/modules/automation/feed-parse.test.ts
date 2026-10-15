import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed-parse.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function entries(xml: string) {
  const parsed = parseFeed(xml);
  if (!parsed.ok) throw new Error(`not a feed: ${parsed.code}`);
  return parsed.entries;
}

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Blog</title>
    <link>https://example.com/</link>
    <item>
      <title>Kubernetes 1.99 &amp; friends</title>
      <link>https://example.com/k8s-199</link>
      <guid isPermaLink="false">post-199</guid>
      <pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Release <b>notes</b> &amp; more</p>]]></description>
    </item>
    <item>
      <title>No guid</title>
      <link>https://example.com/no-guid</link>
      <dc:date>2026-10-05T08:00:00Z</dc:date>
      <description>&lt;p&gt;Escaped &lt;em&gt;tags&lt;/em&gt; &amp;amp; entity&lt;/p&gt;</description>
    </item>
    <item>
      <title>Only a title</title>
    </item>
  </channel>
</rss>`;

describe("parseFeed RSS 2.0 (M10R75)", () => {
  const items = entries(RSS);

  it("reads every item", () => expect(items).toHaveLength(3));

  it("reads title, link, date and summary", () => {
    expect(items[0]).toEqual({
      key: sha("post-199"),
      title: "Kubernetes 1.99 & friends",
      link: "https://example.com/k8s-199",
      date: "2026-10-06T10:00:00.000Z",
      summary: "Release notes &amp; more",
    });
  });

  it("keys an entry by its guid, else its link, else its title", () => {
    expect(items[0]?.key).toBe(sha("post-199"));
    expect(items[1]?.key).toBe(sha("https://example.com/no-guid"));
    expect(items[2]?.key).toBe(sha("Only a title"));
  });

  it("decodes the five entities once and strips tags that appear after decoding", () => {
    expect(items[1]?.summary).toBe("Escaped tags &amp; entity");
    expect(items[1]?.date).toBe("2026-10-05T08:00:00.000Z");
  });

  it("gives null for a missing link or date", () => {
    expect(items[2]).toMatchObject({ link: null, date: null, summary: "" });
  });
});

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom blog</title>
  <link href="https://example.com/feed" rel="self"/>
  <entry>
    <title type="html">First &#38; &#x41;</title>
    <link rel="enclosure" href="https://example.com/a.mp3"/>
    <link rel="alternate" href="https://example.com/first"/>
    <id>tag:example.com,2026:1</id>
    <published>2026-10-06T10:00:00+02:00</published>
    <updated>2026-10-07T10:00:00Z</updated>
    <summary>Short</summary>
  </entry>
  <entry>
    <title>Second</title>
    <link href="https://example.com/second"/>
    <updated>2026-10-07T10:00:00Z</updated>
    <content type="html">Body &lt;b&gt;text&lt;/b&gt;</content>
  </entry>
  <entry>
    <title>Third</title>
    <link rel="enclosure" href="https://example.com/third.mp3"/>
    <link rel="related" href="https://example.com/third-related"/>
    <id>third</id>
  </entry>
</feed>`;

describe("parseFeed Atom", () => {
  const items = entries(ATOM);

  it("reads every entry", () => expect(items).toHaveLength(3));

  it("reads numeric references and prefers published over updated", () => {
    expect(items[0]).toMatchObject({
      key: sha("tag:example.com,2026:1"),
      title: "First & A",
      date: "2026-10-06T08:00:00.000Z",
      summary: "Short",
    });
  });

  it("takes the alternate link, a link without rel, then the first link", () => {
    expect(items[0]?.link).toBe("https://example.com/first");
    expect(items[1]?.link).toBe("https://example.com/second");
    expect(items[2]?.link).toBe("https://example.com/third.mp3");
  });

  it("falls back from summary to content, and from id to link", () => {
    expect(items[1]).toMatchObject({ summary: "Body text", key: sha("https://example.com/second") });
  });
});

describe("parseFeed text rules", () => {
  const wrap = (item: string) => `<rss><channel>${item}</channel></rss>`;

  it("keeps CDATA as it is: no entity is read in it, and a title keeps its angle brackets", () => {
    const [item] = entries(wrap("<item><title><![CDATA[<b>bold</b> &amp; raw]]></title></item>"));
    expect(item?.title).toBe("<b>bold</b> &amp; raw");
  });

  it("leaves an entity it does not know as it is", () => {
    const [item] = entries(wrap("<item><title>A &nbsp; B &bogus; C</title></item>"));
    expect(item?.title).toBe("A &nbsp; B &bogus; C");
  });

  it("drops a numeric reference to a control, a surrogate or an out-of-range character", () => {
    const [item] = entries(wrap("<item><title>a&#0;b&#xD800;c&#x110000;d&#8238;e&#9;f</title></item>"));
    expect(item?.title).toBe("abcde f");
  });

  it("strips bidi, zero-width, tag and control characters and keeps one visible line", () => {
    const hidden = "\u202e\u200b\u2066\u{e0041}\u0007\u0085";
    const [item] = entries(wrap(`<item><title>Ti${hidden}tle\nwith\tbreaks</title></item>`));
    expect(item?.title).toBe("Title with breaks");
    const [other] = entries(
      wrap(`<item><title>t</title><description>Sum${hidden}mary\nof it</description></item>`),
    );
    expect(other?.summary).toBe("Summary of it");
  });

  it("cuts the title at 300 characters and the summary at 1 KiB", () => {
    const [item] = entries(
      wrap(`<item><title>${"t".repeat(900)}</title><description>${"s".repeat(5000)}</description></item>`),
    );
    expect(item?.title).toHaveLength(300);
    expect(item?.summary).toHaveLength(1024);
  });

  it("does not keep a link that is not http or https", () => {
    const [item] = entries(wrap("<item><title>x</title><link>javascript:alert(1)</link></item>"));
    expect(item?.link).toBeNull();
    const [other] = entries(wrap("<item><title>x</title><link>  https://example.com/a b  </link></item>"));
    expect(other?.link).toBe("https://example.com/a b");
  });

  it("reads only direct children of an item, and the unprefixed names", () => {
    const [item] = entries(
      wrap(
        "<item><media:title>media</media:title><title>real</title><x><title>nested</title></x><link>https://example.com/l</link></item>",
      ),
    );
    expect(item?.title).toBe("real");
  });

  it("skips an entry with no title, link or id", () => {
    expect(
      entries(wrap("<item><description>x</description></item><item><title>kept</title></item>")),
    ).toHaveLength(1);
  });

  it("reads the first 100 entries and no more", () => {
    const many = Array.from({ length: 150 }, (_, index) => `<item><title>t${index}</title></item>`).join("");
    const items = entries(wrap(many));
    expect(items).toHaveLength(100);
    expect(items[99]?.title).toBe("t99");
  });

  it("skips comments and processing instructions", () => {
    const items = entries(
      `<?xml version="1.0"?><!-- <item><title>no</title></item> --><rss><channel><?pi x?><item><title>yes</title></item></channel></rss>`,
    );
    expect(items.map((item) => item.title)).toEqual(["yes"]);
  });

  it("reads an RSS 1.0 (RDF) feed", () => {
    const items = entries(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><item><title>rdf</title><link>https://example.com/rdf</link></item></rdf:RDF>`,
    );
    expect(items).toHaveLength(1);
  });

  it("accepts an empty feed", () => {
    expect(entries("<rss><channel><title>x</title></channel></rss>")).toEqual([]);
  });

  it("accepts a byte order mark", () => {
    expect(entries(`\ufeff<rss><channel><item><title>bom</title></item></channel></rss>`)).toHaveLength(1);
  });

  it("is not a feed when the root is something else", () => {
    expect(parseFeed("<html><body><item><title>x</title></item></body></html>")).toEqual({
      ok: false,
      code: "not_a_feed",
    });
  });
});
