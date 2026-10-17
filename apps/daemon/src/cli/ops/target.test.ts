import { describe, expect, it } from "vitest";
import { CliError } from "../open-home.ts";
import { renderUnit } from "../service/unit.ts";
import { mismatch, resolveTarget, UNIT_NAME } from "./target.ts";

const HOME = "/home/u";
const unitText = (home?: string) =>
  renderUnit({
    node: "/usr/bin/node",
    main: "/home/u/.local/share/pap/current/app/main.js",
    ...(home === undefined ? {} : { home }),
    stopTimeoutSec: 40,
  });

describe("unit name (M6bR50)", () => {
  it("the flag wins over PAP_UNIT, which wins over pap.service", () => {
    expect(resolveTarget({ unit: "a.service" }, { PAP_UNIT: "b.service" }, HOME, null).unit).toBe(
      "a.service",
    );
    expect(resolveTarget({}, { PAP_UNIT: "b.service" }, HOME, null).unit).toBe("b.service");
    expect(resolveTarget({}, {}, HOME, null).unit).toBe("pap.service");
    expect(resolveTarget({}, { PAP_UNIT: "" }, HOME, null).unit).toBe("pap.service");
  });
  const refused = (run: () => unknown) => {
    const error = (() => {
      try {
        run();
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(64);
  };
  it.each([
    "bad name",
    "../x.service",
    `${"a".repeat(65)}.service`,
    "a b.service",
    "pap",
    "Pap.service",
    "x.service\n",
  ])("%j is a usage error (64), by flag and by PAP_UNIT", (unit) => {
    refused(() => resolveTarget({ unit }, {}, HOME, null));
    refused(() => resolveTarget({}, { PAP_UNIT: unit }, HOME, null));
  });
  it("a name of exactly 64 characters before .service is accepted", () => {
    expect(resolveTarget({ unit: `${"a".repeat(64)}.service` }, {}, HOME, null).unit).toHaveLength(72);
  });
  it("the pattern accepts the documented shapes", () => {
    for (const ok of ["pap.service", "pap-preview.service", "pap@1.service", "a_b.service"])
      expect(UNIT_NAME.test(ok)).toBe(true);
  });
});

describe("home order: flag, environment, unit, default", () => {
  const parsedHome = unitText("/unit/home");
  it("flag", () => {
    const t = resolveTarget({ home: "/flag/home" }, { PAP_HOME: "/env/home" }, HOME, parsedHome);
    expect([t.home, t.homeSource, t.unitHome]).toEqual(["/flag/home", "flag", "/unit/home"]);
  });
  it("environment", () => {
    const t = resolveTarget({}, { PAP_HOME: "/env/home" }, HOME, parsedHome);
    expect([t.home, t.homeSource]).toEqual(["/env/home", "environment"]);
  });
  it("unit", () => {
    const t = resolveTarget({}, {}, HOME, parsedHome);
    expect([t.home, t.homeSource, t.parsed?.home]).toEqual(["/unit/home", "unit", "/unit/home"]);
  });
  it("default", () => {
    const t = resolveTarget({}, {}, HOME, null);
    expect([t.home, t.homeSource, t.unitHome, t.parsed]).toEqual(["/home/u/.pap", "default", null, null]);
  });
  it("a unit without PAP_HOME gives the default and no unitHome", () => {
    const t = resolveTarget({}, {}, HOME, unitText());
    expect([t.home, t.homeSource, t.unitHome]).toEqual(["/home/u/.pap", "default", null]);
    expect(t.parsed).not.toBeNull();
  });
  it("a tilde in PAP_HOME expands like the daemon", () => {
    expect(resolveTarget({}, { PAP_HOME: "~/x" }, HOME, null).home).toBe("/home/u/x");
  });
  it("a relative --home is a usage error", () => {
    expect(() => resolveTarget({ home: "rel/dir" }, {}, HOME, null)).toThrow(CliError);
  });
  it("a text that is not our unit is treated as no unit", () => {
    const t = resolveTarget({}, {}, HOME, "[Service]\nExecStart=/bin/sh -c x\n");
    expect([t.parsed, t.homeSource]).toEqual([null, "default"]);
  });
});

describe("mismatch", () => {
  const unit = unitText("/x");
  it("is a sentence when the unit's home is /x and the environment says /y without --home", () => {
    const sentence = mismatch(resolveTarget({}, { PAP_HOME: "/y" }, HOME, unit));
    expect(sentence).toContain("/x");
    expect(sentence).toContain("/y");
    expect(sentence).toContain("--home");
  });
  it("is null with --home", () => {
    expect(mismatch(resolveTarget({ home: "/y" }, {}, HOME, unit))).toBeNull();
  });
  it("is null with no unit", () => {
    expect(mismatch(resolveTarget({}, { PAP_HOME: "/y" }, HOME, null))).toBeNull();
  });
  it("is null when they are equal", () => {
    expect(mismatch(resolveTarget({}, { PAP_HOME: "/x" }, HOME, unit))).toBeNull();
    expect(mismatch(resolveTarget({}, {}, HOME, unit))).toBeNull();
  });
  it("a unit without PAP_HOME against ~/.pap is a mismatch only when it names no home: null", () => {
    expect(mismatch(resolveTarget({}, {}, HOME, unitText()))).toBeNull();
  });
});
