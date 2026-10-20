import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A small agent bundle as `pnpm deploy` leaves it (plus the folders `finishAgentBundle` prunes): one relative link inside. */
export const putAgentBundle = (bundle: string, { deployed = false } = {}): void => {
  put(
    join(bundle, "package.json"),
    deployed
      ? JSON.stringify({
          name: "@pap/pi-host",
          version: "0.0.0",
          type: "module",
          exports: { ".": { development: "./src/main.ts", default: "./dist/main.js" } },
          dependencies: { "@pap/contracts": `@pap/contracts@file://${bundle}/../contracts`, zod: "4.6.5" },
        })
      : '{"name":"@pap/pi-host","type":"module"}\n',
  );
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
    put(join(bundle, "dist-agent/package.json"), `{"from":"${bundle}"}`);
    put(join(bundle, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    put(join(bundle, "node_modules/.modules.yaml"), `prunedAt: ${Date.now()}\nstoreDir: ${bundle}/store\n`);
    put(join(bundle, "node_modules/.pnpm/lock.yaml"), `path: ${bundle}\n`);
    put(join(bundle, "node_modules/.pnpm-workspace-state-v1.json"), "{}");
    put(join(bundle, "node_modules/@pap/contracts/package.json"), '{"name":"@pap/contracts"}');
    put(join(bundle, "node_modules/@pap/contracts/dist/main.js"), "export {};\n");
    put(join(bundle, "node_modules/@pap/contracts/src/main.ts"), "export {};\n");
    put(join(bundle, "node_modules/@pap/contracts/tsconfig.json"), "{}\n");
    put(join(bundle, "node_modules/dep/a.test.js"), "x");
    put(join(bundle, "node_modules/dep/b.spec.mjs"), "x");
  }
};
