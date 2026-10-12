/** `/ask`: a select, an input, an editor and a confirm in a row, then one notice with the four answers. */
export const ASK_ALL = `export default function (pi) {
  pi.registerCommand("ask", { handler: async (_args, ctx) => {
    const picked = await ctx.ui.select("Pick one", ["a", "b"]);
    const typed = await ctx.ui.input("Type", "placeholder");
    const edited = await ctx.ui.editor("Edit", "draft text");
    const sure = await ctx.ui.confirm("Sure?", "really");
    ctx.ui.notify("answers:" + [picked, typed, edited, sure].join("|"), "info");
  } });
}
`;

/** A status with a command button, a plain status, and the command the button runs. */
export const STATUS_BAR = `export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("command:/hello", "Say hello");
    ctx.ui.setStatus("branch", "main");
  });
  pi.registerCommand("hello", { handler: async (_args, ctx) => ctx.ui.notify("hello from the status bar", "info") });
}
`;

/** A widget of lines above the editor, a component widget below it, and /tick to re-render the component. */
export const WIDGETS = `export default function (pi) {
  let ticks = 0;
  let render = () => {};
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("todo", ["- write tests", "- ship"]);
    ctx.ui.setWidget("ticker", (tui) => { render = () => tui.requestRender(); return { render: () => ["ticks: " + ticks], invalidate() {} }; }, { placement: "belowEditor" });
  });
  pi.registerCommand("tick", { handler: async () => { ticks += 1; render(); } });
}
`;

/** /pick: the S1 panel (alpha / beta, arrow down, enter), then a notice with the choice. */
export const PICKER = `export default function (pi) {
  pi.registerCommand("pick", { handler: async (_args, ctx) => {
    const choice = await ctx.ui.custom((_tui, _theme, _keys, done) => {
      const items = ["alpha", "beta"];
      let cursor = 0;
      return {
        render: (width) => items.map((item, i) => ((i === cursor ? "> " : "  ") + item).slice(0, width)),
        handleInput: (data) => { if (data === "\\u001b[B") cursor = 1; else if (data === "\\r") done(items[cursor]); },
        invalidate() {},
      };
    });
    ctx.ui.notify("picked:" + choice, "info");
  } });
}
`;

/** /fill: puts text in the composer, as the pi TUI's setEditorText does. */
export const EDITOR_TEXT = `export default function (pi) {
  pi.registerCommand("fill", { handler: async (_args, ctx) => ctx.ui.setEditorText("text from the extension") });
}
`;

/** An extension that writes the reason of every `session_shutdown` it is told of (R106) to `path`, one line each. */
export const shutdownProbe = (path: string): string =>
  `import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("session_shutdown", (event) => appendFileSync(${JSON.stringify(path)}, event.reason + "\\n")); }\n`;

/** Like `shutdownProbe`, but its `session_shutdown` handler takes `ms` longer: the worker is closing for at least that long. */
export const slowShutdownProbe = (path: string, ms: number): string =>
  `import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("session_shutdown", async (event) => { await new Promise((resolve) => setTimeout(resolve, ${ms})); appendFileSync(${JSON.stringify(path)}, event.reason + "\\n"); }); }\n`;

/** Throws in session_start and in every tool_call handler: pap reports, Pi carries on. */
export const THROWER = `export default function (pi) {
  pi.on("session_start", () => { throw new Error("start failed"); });
  pi.on("tool_call", () => { throw new Error("tool_call failed"); });
}
`;

/** /die: kills its own worker with SIGKILL, as an OOM kill or a segfault would. */
export const KILLER = `export default function (pi) {
  pi.registerCommand("die", { handler: async () => { process.kill(process.pid, "SIGKILL"); } });
}
`;

/** /flood: 70 confirms at once and a widget of 10 000 long lines. */
export const FLOOD = `export default function (pi) {
  pi.registerCommand("flood", { handler: async (_args, ctx) => {
    ctx.ui.setWidget("huge", Array.from({ length: 10000 }, () => "w".repeat(5000)));
    await Promise.all(Array.from({ length: 70 }, (_, i) => ctx.ui.confirm("Q" + i, "?")));
  } });
}
`;

/** Never finishes its session_shutdown handler. */
export const HANGER = `export default function (pi) { pi.on("session_shutdown", () => new Promise(() => {})); }
`;

/** Bounded allocation steps of 16 MiB: the hog stops itself after \`steps\` of them, so a missing limit fails instead of eating the host. */
const HOG_STEP_MB = 16;

/** /hog: allocates until something stops it; stops itself (exit 3) at \`ceilingMb\`, which callers set to twice the scope limit. */
export const hog = (ceilingMb: number): string => `export default function (pi) {
  pi.registerCommand("hog", { handler: async () => {
    const kept = [];
    while (kept.length < ${Math.ceil(ceilingMb / HOG_STEP_MB)}) { kept.push(Buffer.alloc(${HOG_STEP_MB} * 1024 * 1024, 1)); await new Promise((r) => setImmediate(r)); }
    process.exit(3);
  } });
}
`;

/** The same hog as a shell command (node -e), for a command the agent runs. It raises its own oom_score_adj first: the worker sits at 800 and its children inherit it, so without this the kernel may pick the worker. */
export const hogCommand = (ceilingMb: number): string =>
  `node -e "require('fs').writeFileSync('/proc/self/oom_score_adj','1000');const k=[];setInterval(()=>{if(k.length>=${Math.ceil(ceilingMb / HOG_STEP_MB)})process.exit(3);k.push(Buffer.alloc(${HOG_STEP_MB}*1024*1024,1))},10)"`;
