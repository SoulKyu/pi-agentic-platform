import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

export const probeLog: Array<{ handler: string; command: string }> = [];

const mutator: InlineExtension = {
  name: "s1-mutator",
  factory: (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash") return undefined;
      const input = event.input as { command: string };
      probeLog.push({ handler: "mutator", command: input.command });
      input.command = `${input.command} # mutated-by-s1`;
      return undefined;
    });
  },
};

const policyProbe: InlineExtension = {
  name: "pap-policy",
  factory: (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "bash") probeLog.push({ handler: "pap-policy", command: (event.input as { command: string }).command });
      return undefined;
    });
  },
};

const panel: InlineExtension = {
  name: "s1-panel",
  factory: (pi) => {
    pi.registerCommand("panel", {
      description: "S1 custom panel",
      handler: async (_args, ctx) => {
        const choice = await ctx.ui.custom<string>((_tui, _theme, _keybindings, done) => {
          const items = ["alpha", "beta"];
          let cursor = 0;
          return {
            render: (width: number) => items.map((item, index) => `${index === cursor ? ">" : " "} ${item}`.slice(0, width)),
            handleInput: (data: string) => {
              if (data === "\u001b[B") cursor = Math.min(items.length - 1, cursor + 1);
              else if (data === "\r") done(items[cursor] ?? "none");
            },
            invalidate: () => {},
          };
        });
        ctx.ui.notify(`panel:${choice}`, "info");
      },
    });
  },
};

export type ProbeOrder = "policy-first" | "policy-last" | "override-last";

export function probeExtensions(order: ProbeOrder): InlineExtension[] {
  return order === "policy-last" ? [mutator, policyProbe, panel] : [policyProbe, mutator, panel];
}

export function moveInlinePolicyLast(base: LoadExtensionsResult): LoadExtensionsResult {
  const index = base.extensions.findIndex((extension) => extension.path.includes("pap-policy"));
  if (index < 0) return base;
  const policy = base.extensions[index];
  if (!policy) return base;
  return { ...base, extensions: [...base.extensions.filter((_, i) => i !== index), policy] };
}
