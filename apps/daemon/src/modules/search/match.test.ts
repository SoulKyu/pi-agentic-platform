import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { matchExpression, MAX_QUERY_TERMS, MIN_PREFIX_POINTS } from "./match.ts";

describe("matchExpression (M4R47)", () => {
  it("quotes every word, all required, the last as a prefix while it is typed", () => {
    expect(matchExpression("kubernetes cafe")).toBe('"kubernetes" AND "cafe"*');
    expect(matchExpression("kubernetes cafe ")).toBe('"kubernetes" AND "cafe"');
    expect(matchExpression("a")).toBe('"a"');
    expect(matchExpression("ab")).toBe('"ab"');
    expect(matchExpression("abc")).toBe('"abc"*');
    expect(matchExpression("Déploiement")).toBe('"Déploiement"*');
    expect(MIN_PREFIX_POINTS).toBe(3);
  });

  it("never lets FTS5 syntax through", () => {
    // Nine words: the eighth kept is not the input's last, so no prefix.
    expect(matchExpression('foo" OR bar NEAR(x, y) col:val ^start *')).toBe(
      '"foo" AND "OR" AND "bar" AND "NEAR" AND "x" AND "y" AND "col" AND "val"',
    );
    expect(matchExpression("(a) AND -b")).toBe('"a" AND "AND" AND "b"');
    expect(matchExpression("(abc) AND -bcd")).toBe('"abc" AND "AND" AND "bcd"*');
    expect(matchExpression("cluster)")).toBe('"cluster"');
    // The ninth word is cut, so the eighth kept is not the one being typed: no prefix even though the input ends on a word.
    expect(matchExpression("aaa bbb ccc ddd eee fff ggg hhh iii")).toBe(
      '"aaa" AND "bbb" AND "ccc" AND "ddd" AND "eee" AND "fff" AND "ggg" AND "hhh"',
    );
  });

  it("is null when nothing searchable is left, and keeps at most MAX_QUERY_TERMS terms", () => {
    for (const blank of ["", "   ", "*:()\"'", "\u0000\u202E"]) expect(matchExpression(blank)).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    expect(matchExpression(many)).toBe(
      Array.from({ length: MAX_QUERY_TERMS }, (_, i) => `"w${i}"`).join(" AND "),
    );
    expect(matchExpression("x".repeat(200))).toBe(`"${"x".repeat(64)}"*`);
    // A letter outside the BMP that NFKC keeps (U+10400) is two units: 40 of them are cut to 32, never to half a pair.
    expect(matchExpression("\u{10400}".repeat(40))).toBe(`"${"\u{10400}".repeat(32)}"*`);
  });

  it("every expression it builds is valid FTS5, whatever was typed", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(text, tokenize='unicode61 remove_diacritics 2'); INSERT INTO t VALUES ('hello world');",
    );
    const hostile = [
      '"',
      '""',
      "NEAR(",
      "a:b",
      "^x",
      "x*",
      "OR",
      "AND NOT",
      "{a b}",
      "a\u0000b",
      "١٢٣",
      "\u{1F642} ok",
      "x'); DROP TABLE t; --",
      "e\u0301té",
      "\u{10400}\u{10400}\u{10400}",
    ];
    for (const input of hostile) {
      const expression = matchExpression(input);
      if (expression !== null)
        expect(
          () => db.prepare("SELECT count(*) FROM t WHERE t MATCH ?").get(expression),
          input,
        ).not.toThrow();
    }
    db.close();
  });

  describe("prefix minimum on the tokens FTS5 really produces (I1)", () => {
    // U+093F (Devanagari vowel sign I) and U+20D0 are marks outside unicode61's diacritic table: FTS5 splits at them.
    const vowel = "\u093F";
    const ring = "\u20D0";
    const index = (...texts: string[]) => {
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE VIRTUAL TABLE t USING fts5(text, tokenize='unicode61 remove_diacritics 2')");
      for (const text of texts) db.prepare("INSERT INTO t VALUES (?)").run(text);
      const find = (input: string) => {
        const expression = matchExpression(input);
        if (expression === null) return null;
        return (
          db.prepare("SELECT text FROM t WHERE t MATCH ? ORDER BY rowid").all(expression) as Array<{
            text: string;
          }>
        ).map((row) => row.text);
      };
      return { find };
    };

    it("never makes a prefix of fewer than 3 characters, whatever separates them", () => {
      for (const input of [
        `b${vowel}${vowel}`,
        `${vowel}${vowel}b`,
        `abc${ring}z`,
        `a${vowel}b${vowel}c`,
        `ab${ring}`,
      ])
        expect(matchExpression(input), JSON.stringify(input)).not.toContain("*");
    });

    it("keeps the prefix when the last piece has 3 characters, and for ordinary Hindi it is a phrase without prefix", () => {
      expect(matchExpression(`ab${vowel}cde`)).toBe(`"ab${vowel}cde"*`);
      expect(matchExpression("\u0915\u093F\u0924\u093E\u092C")).not.toContain("*");
      expect(matchExpression("cafe\u0301s")).toBe('"caf\u00E9s"*');
    });

    it("on a real index, a one-letter prefix does not expand", () => {
      const { find } = index("b", "b1 b2 b3", "bar", "xyz abcdef", "ab c");
      expect(find(`b${vowel}${vowel}`)).toEqual(["b"]);
      expect(find(`${vowel}${vowel}b`)).toEqual(["b"]);
      expect(find(`abc${ring}d`)).toEqual([]);
      expect(find("ab")).toEqual(["ab c"]);
      expect(find("abc")).toEqual(["xyz abcdef"]);
    });

    it("a Hindi word typed normally finds itself", () => {
      const word = "\u0915\u093F\u0924\u093E\u092C";
      const { find } = index(`un ${word} deux`, "autre");
      expect(find(word)).toEqual([`un ${word} deux`]);
    });
  });
});
