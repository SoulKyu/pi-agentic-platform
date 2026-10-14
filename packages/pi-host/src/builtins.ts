import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

type Notify = (message: string, type: "info" | "warning") => void;

/**
 * M7R31, amended after review: in rpc mode Pi's `/mcp` already shows the sign-in URL as text and then calls `openUrl`.
 * pap opens no browser and adds a fixed instruction that never repeats the URL: paste the redirect address into the prompt.
 */
export function signInNotifier(notify: Notify): (url: string) => void {
  return (url) => {
    if (isWebAddress(url))
      notify(
        "MCP sign-in: open the link above in your browser, then paste the address you are sent to into the prompt.",
        "info",
      );
    else notify("MCP sign-in: the link above is not an http or https address. Do not open it.", "warning");
  };
}

function isWebAddress(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Pi's own MCP, codemode and tool-search extensions under the names and flags the CLI gives them (M5R24, decision 74):
 * their tools then carry `builtin:mcp`, `builtin:codemode` and `builtin:tool-search`, the only sources pap-policy
 * classifies as MCP, codemode and tool search. A bare factory would be `<inline:N>` and classify as unknown.
 */
export function piBuiltins(options: { readonly showSignInLink: (url: string) => void }): InlineExtension[] {
  return [
    {
      name: "mcp",
      factory: createMcpExtension({ openUrl: options.showSignInLink }),
      builtin: true,
      replaceable: true,
    },
    // `models: false`: scripts get no model catalog or classifier, whose calls would send script data to a provider
    // outside any judged tool call (M5R carry).
    {
      name: "codemode",
      factory: createCodemodeExtension({ models: false }),
      builtin: true,
      replaceable: true,
    },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
  ];
}
