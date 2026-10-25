import { describe, expect, it } from "vitest";
import { inviteEn, inviteFr } from "./catalog/invite.ts";

describe("lazy catalog (invitation)", () => {
  it("has the same keys and placeholders in English and French", () => {
    expect(Object.keys(inviteFr)).toEqual(Object.keys(inviteEn));
    const slots = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(inviteEn) as Array<keyof typeof inviteEn>)
      expect(slots(inviteFr[key]), key).toEqual(slots(inviteEn[key]));
  });
});
