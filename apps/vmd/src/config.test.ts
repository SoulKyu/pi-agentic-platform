import { describe, expect, it } from "vitest";
import { parseVmdConfig } from "./config.ts";

describe("parseVmdConfig", () => {
  it("reads the three fields pap vm setup writes", () => {
    expect(parseVmdConfig('{"papUid":1000,"papGid":1001,"papHome":"/home/pap/.pap","extra":1}')).toEqual({
      papUid: 1000,
      papGid: 1001,
      papHome: "/home/pap/.pap",
    });
  });

  it.each([
    ["root as pap's uid", '{"papUid":0,"papGid":1000,"papHome":"/h"}'],
    ["a string uid", '{"papUid":"1000","papGid":1000,"papHome":"/h"}'],
    ["a negative gid", '{"papUid":1000,"papGid":-1,"papHome":"/h"}'],
    ["a relative home", '{"papUid":1000,"papGid":1000,"papHome":"h"}'],
    ["a missing home", '{"papUid":1000,"papGid":1000}'],
    ["an array", "[]"],
    ["null", "null"],
  ])("refuses %s", (_name, text) => {
    expect(() => parseVmdConfig(text)).toThrow();
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseVmdConfig("{")).toThrow();
  });
});
