import { classifyTool } from "./tool-kind.ts";

/** What the worker's redaction needs of a registered tool: its name and where Pi says it came from. */
export interface RegisteredTool {
  readonly name: string;
  readonly sourceInfo: { readonly path: string };
}

/**
 * Whether a name is Pi's own tool (M5R116), for the redaction of records. It fails toward masking: with no registry yet,
 * or a registry that throws, every name counts as built in, so the stricter edge masks apply.
 */
export function createIsBuiltin(
  tools: () => readonly RegisteredTool[] | undefined,
): (name: string) => boolean {
  return (name) => {
    try {
      const all = tools();
      if (all === undefined) return true;
      const info = all.find((tool) => tool.name === name);
      return classifyTool(name, info ? { path: info.sourceInfo.path } : undefined).builtin;
    } catch {
      return true;
    }
  };
}
