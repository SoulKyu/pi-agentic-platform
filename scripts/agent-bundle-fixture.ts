import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A small agent bundle as `pnpm deploy` leaves it (plus the folders `finishAgentBundle` prunes): one relative link inside. */
export const putAgentBundle = (bundle: string, { deployed = false } = {}): void => {
  put(join(bundle, "package.json"), '{"name":"@pap/pi-host","type":"module"}\n');
  put(join(bundle, "dist/main.js"), "export {};\n");
  put(join(bundle, "dist/guest/main.js"), "export {};\n");
  put(join(bundle, "dist/relay/main.js"), "export {};\n");
  put(join(bundle, "node_modules/dep/package.json"), '{"name":"dep","version":"1.0.0"}\n');
  put(join(bundle, "node_modules/dep/cli.js"), "export {};\n");
  mkdirSync(join(bundle, "node_modules/.bin"), { recursive: true });
  symlinkSync("../dep/cli.js", join(bundle, "node_modules/.bin/dep"));
  if (deployed) {
    put(join(bundle, "src/main.ts"), "export {};\n");
    put(join(bundle, "tsconfig.json"), "{}\n");
    put(join(bundle, "tsconfig.build.json"), "{}\n");
    put(join(bundle, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  }
};
