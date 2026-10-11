import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Writes `<agentDir>/extensions/<name>.js`, which Pi loads at start. */
export function writeExtension(agentDir: string, name: string, source: string): void {
  const dir = join(agentDir, "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.js`), source);
}

/** `/pick`: a two-item list panel (arrow down moves, enter answers), then a notification with the choice. */
export const PICKER_SOURCE = `export default function (pi) {
  pi.registerCommand("pick", {
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.custom((_tui, _theme, _keys, done) => {
        let cursor = 0;
        const items = ["alpha", "beta"];
        return {
          render: () => items.map((item, i) => (i === cursor ? "> " : "  ") + item),
          handleInput: (data) => {
            if (data === "\\u001b[B") cursor = 1;
            else if (data === "\\r") done(items[cursor]);
          },
          invalidate: () => {},
        };
      });
      ctx.ui.notify("picked:" + choice, "info");
    },
  });
}
`;

/**
 * `/hostile`: a panel that renders cursor moves, a title set, a hyperlink and a bell around coloured text, and a
 * widget factory that does the same; the host must send neither as anything but inert text.
 */
export const HOSTILE_SOURCE = `export default function (pi) {
  const hostile = "\\u001b[31mred\\u001b[0m\\u001b]8;;https://evil.test\\u0007link\\u001b]8;;\\u0007\\u001b[2J\\u001b]0;pwn\\u0007\\u0007!";
  pi.registerCommand("hostile", {
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("evil", () => ({ render: () => [hostile], invalidate: () => {} }));
      await ctx.ui.custom((_tui, _theme, _keys, done) => ({
        render: () => [hostile],
        handleInput: () => done(undefined),
        invalidate: () => {},
      }));
    },
  });
}
`;
