import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import reactCompiler from "babel-plugin-react-compiler";
import { describe, expect, it } from "vitest";

// R122 / R128: the React Compiler skips a component it cannot prove safe without saying so. Every component file
// of the UI package and the web app goes through it here; any CompileError or PipelineError fails the gate.
const REPO = resolve(import.meta.dirname, "../../..");
// M2's folder: the compiler bails out on its try/finally; post-merge task P7 removes this exclusion (M3-RT-24).
const ROOTS = ["packages/ui/src", "apps/web/src"];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "testing" ? [] : tsxFiles(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

interface CompilerEvent {
  readonly kind: string;
  readonly detail?: unknown;
  readonly data?: unknown;
}

async function compilerEvents(path: string, code = readFileSync(path, "utf8")): Promise<CompilerEvent[]> {
  const events: CompilerEvent[] = [];
  await transformAsync(code, {
    filename: path,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    // The plugin itself, not its name: Babel would resolve a name from the repository root (M3-RT-04).
    plugins: [
      [
        reactCompiler,
        {
          panicThreshold: "none",
          logger: { logEvent: (_file: string | null, event: CompilerEvent) => events.push(event) },
        },
      ],
    ],
  });
  return events;
}

const files = ROOTS.flatMap((root) => tsxFiles(join(REPO, root))).map((path) => relative(REPO, path));

describe("React Compiler gate", () => {
  it("covers the UI package and the web app", () => {
    expect(files.some((file) => file.startsWith("packages/ui/"))).toBe(true);
    expect(files.some((file) => file.startsWith("apps/web/"))).toBe(true);
  });

  it.each(files)("%s compiles with no bailout", async (file) => {
    const failures = (await compilerEvents(join(REPO, file))).filter(
      (e) => e.kind === "CompileError" || e.kind === "PipelineError",
    );
    expect(failures.map((e) => JSON.stringify(e.detail ?? e.data ?? e).slice(0, 400))).toEqual([]);
  });

  it("reports a component the compiler cannot compile (a finally clause)", async () => {
    const code =
      "export function C() { const run = async () => { try { await f(); } finally { g(); } }; return <b onClick={run} />; }";
    const events = await compilerEvents("fixture.tsx", code);
    expect(events.some((e) => e.kind === "CompileError" || e.kind === "PipelineError")).toBe(true);
  });
});
