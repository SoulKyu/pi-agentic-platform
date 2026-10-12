// Every `import … from "zod"` of the web build resolves to this module (vite.config.ts `resolve.alias`), so zod is
// switched to jitless before any schema is built, whatever chunk the schemas end up in.
import * as z from "zod/v4";

z.config({ jitless: true });

export * from "zod/v4";
export { z, z as default };
