import { z } from "zod";

// zod builds a `new Function` fast path for object schemas unless told not to, and probes for `eval` with
// `Function("")` when it builds the first one. The daemon's CSP has no 'unsafe-eval' (R74), so that probe would be
// a violation on every page load. Schemas read this setting when they are built: main.tsx imports this file
// before anything that defines one.
z.config({ jitless: true });
