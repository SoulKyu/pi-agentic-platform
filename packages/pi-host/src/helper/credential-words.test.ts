import * as contracts from "@pap/contracts";
import { describe, expect, it } from "vitest";
import * as helper from "./credential-words.ts";

// The vocabulary and its cases are tested once, in packages/contracts/src/credential-words.test.ts. The helper only
// re-exports it, so both maskers cannot drift (MC40): this pins that it is the same objects.
describe("the helper's credential vocabulary is the contracts' one (MC40)", () => {
  it("re-exports the same words, function and pattern", () => {
    expect(helper.CREDENTIAL_WORDS).toBe(contracts.CREDENTIAL_WORDS);
    expect(helper.credentialName).toBe(contracts.credentialName);
    expect(helper.COMMENT_WORD).toBe(contracts.COMMENT_WORD);
  });
});
