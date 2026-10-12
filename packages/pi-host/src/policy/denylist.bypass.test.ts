import { afterAll, beforeAll, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

// What the reader does not see (M5R18, RT-35). A change that starts blocking one of these changes this test and
// docs/agents/policy.md together; the real barrier is the stage-05 sandbox.
it.each([
  ["a variable as the command word", "$x -rf /"],
  ["globbing past the leading `/*` spellings", "rm -rf /[a-z]*"],
  ["brace expansion", "{rm,-rf,/}"],
  ["ANSI-C quoting", "$'\\x72m' -rf /"],
  ["a parent spelling of the root", "rm -rf /.."],
  ["a root reached by cd", "cd / && rm -rf *"],
  ["find with -delete", "find / -delete"],
  ["arguments from standard input", "echo / | xargs rm -rf"],
  ["a here-string fed to a shell", 'bash <<< "rm -rf /"'],
  ["output piped to a shell", "printf 'rm -rf /' | sh"],
  ["an interpreter", `python3 -c "import shutil; shutil.rmtree('/')"`],
])("documented pass: %s", async (_name, command) => {
  const h = bed.harness({ rules: () => interactiveRules, stages: ALLOW_03 });
  expect(await h.run("bash", { command })).toBeUndefined();
});
