import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const piHostDir = fileURLToPath(new URL("..", import.meta.url));

describe("Node 24 type stripping across workspace packages", () => {
  it("imports @pap/contracts from its TypeScript sources under the development condition", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--conditions=development",
        "--input-type=module",
        "-e",
        "const m = await import('@pap/contracts'); process.stdout.write(String(m.PROTOCOL_VERSION));",
      ],
      { cwd: piHostDir, encoding: "utf8" },
    );
    expect(output).toBe("2");
  });
});
