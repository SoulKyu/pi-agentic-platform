import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const HERE = fileURLToPath(new URL("./", import.meta.url));

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}
const production = (dir: string): string[] =>
  [...walk(dir)].filter(
    (path) => !path.endsWith(".test.ts") && !relative(SRC, path).split("/").includes("testing"),
  );

describe("the test override stays in tests", () => {
  it("no production file imports egress/testing or any testing folder from this module", () => {
    const offenders = production(join(SRC)).filter((path) =>
      /from\s+["'][^"']*egress\/testing\//.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
    const inside = production(HERE).filter((path) => /["']\.\/testing\//.test(readFileSync(path, "utf8")));
    expect(inside).toEqual([]);
  });

  it("only the composition passes the VM address policy to the VM listener", () => {
    const users = production(SRC)
      .filter((path) => /\bvmAddressRefused\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .sort();
    expect(users).toEqual([
      "compose-agents-vm-proxy.ts",
      "kernel/net/vm-address.ts",
      "modules/egress/index.ts",
      "modules/egress/vm-judge.ts",
    ]);
  });

  it("the module (outside testing/) reads no environment variable", () => {
    const files = production(HERE);
    expect(files.length).toBeGreaterThan(5);
    const readers = files.filter((path) =>
      /process\.env|process\[["']env["']\]/.test(readFileSync(path, "utf8")),
    );
    expect(readers).toEqual([]);
  });
});
