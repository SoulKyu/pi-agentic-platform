import { join, resolve } from "node:path";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");

// The gate above runs Babel directly; this proves the app's own Vite pipeline compiles files of @pap/ui too
// (R128): a component of the package, built through apps/web/vite.config.ts, imports the compiler runtime.
describe("the web build runs the React Compiler on @pap/ui", () => {
  it("compiles a primitive of packages/ui", async () => {
    const output = (await build({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      build: {
        write: false,
        lib: {
          entry: join(repoRoot, "packages/ui/src/ai/ApprovalCard.tsx"),
          formats: ["es"],
          fileName: "probe",
        },
        rollupOptions: { external: (id) => /^(react|react-dom|radix-ui|lucide-react)(\/|$)/.test(id) },
      },
    })) as Rollup.RollupOutput[];
    const code = output
      .flatMap((o) => o.output)
      .map((chunk) => ("code" in chunk ? chunk.code : ""))
      .join("\n");
    expect(code).toMatch(/react\/compiler-runtime/);
  }, 60_000);
});
