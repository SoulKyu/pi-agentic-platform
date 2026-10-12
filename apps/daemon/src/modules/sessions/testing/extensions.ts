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
