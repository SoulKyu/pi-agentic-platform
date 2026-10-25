import {
  HELPER_OPS,
  MODELS_CONFIG_ISSUE_MAX_LENGTH,
  MODELS_CONFIG_TEXT_MAX,
  type ConfigSaveResult,
} from "@pap/contracts/pi-host";
import { z } from "zod";
import { JsoncError, parseJsonc } from "../jsonc.ts";
import { unmaskModelsJson } from "../models-json-mask.ts";
import { defineOp, type HelperContext, HelperOpError, type HelperOp } from "../ops.ts";
import { brokenIssues, lineColumn } from "./models-json-issues.ts";
import {
  commitText,
  INVALID_ROOT,
  invalid,
  location,
  maskOrRefuse,
  piRejects,
  readCurrent,
  revisionOf,
  tooLarge,
} from "./models-json-shared.ts";

/** What a save can put back: the secrets of the file as it is, none when it does not parse (a broken file is shown to nobody, so no placeholder can come from it). */
function priorSecrets(current: string | null) {
  if (current === null || brokenIssues(current) !== null) return { secrets: [], places: [] };
  return maskOrRefuse(current);
}

export const configGet: HelperOp<
  z.infer<(typeof HELPER_OPS)["models.config.get"]["params"]>,
  z.infer<(typeof HELPER_OPS)["models.config.get"]["result"]>
> = {
  params: HELPER_OPS["models.config.get"].params,
  run: async (params, ctx) => {
    const { path } = location(ctx);
    const current = await readCurrent(ctx);
    const revision = revisionOf(params.revisionKey, current);
    if (current === null) return { text: null, issues: [], revision, path };
    // Fail closed: a file that does not parse is not shown at all, since masking cannot be trusted on it (MC32).
    const broken = brokenIssues(current);
    if (broken !== null) return { text: null, issues: broken, revision, path };
    const { masked } = maskOrRefuse(current);
    if (tooLarge(masked)) return { text: null, issues: ["text too large"], revision, path };
    return { text: masked, issues: [], revision, path };
  },
};

// ---- validation (M7R64): Pi's own tolerance, a lenient shape, then Pi's own loader ----

const Text = z.string();
const Provider = z
  .object({
    name: Text.optional(),
    baseUrl: Text.optional(),
    apiKey: Text.optional(),
    api: Text.optional(),
    authHeader: z.boolean().optional(),
    headers: z.record(Text, Text).optional(),
    models: z.array(z.object({ id: Text.min(1) }).loose()).optional(),
  })
  .loose();
const Shape = z.object({ providers: z.record(Text, Provider).optional() }).loose();

/** A JSON path from a zod path: keys are clipped and reduced to plain characters, since a key is file text. */
function pathOf(path: ReadonlyArray<PropertyKey>): string {
  const parts = path.map((part) =>
    typeof part === "number"
      ? `[${part}]`
      : `.${String(part)
          .replace(/[^\w-]/g, "*")
          .slice(0, 32)}`,
  );
  return `$${parts.join("")}`.replace(/\.\[/g, "[").slice(0, MODELS_CONFIG_ISSUE_MAX_LENGTH);
}

/** JSON paths and positions only: a parser's or Pi's message can quote a secret, so none is ever returned. */
async function issuesOf(text: string, ctx: HelperContext): Promise<string[]> {
  const broken = brokenIssues(text);
  if (broken !== null) return broken;
  const shape = Shape.safeParse(parseJsonc(text));
  if (!shape.success) return [...new Set(shape.error.issues.map((issue) => pathOf(issue.path)))];
  return (await piRejects(text, ctx)) ? INVALID_ROOT : [];
}

// ---- enabledModels follows the file (M7R65) ----

export const configSave: HelperOp<
  z.infer<(typeof HELPER_OPS)["models.config.save"]["params"]>,
  ConfigSaveResult
> = {
  params: HELPER_OPS["models.config.save"].params,
  run: async (params, ctx) => {
    const current = await readCurrent(ctx);
    if (revisionOf(params.revisionKey, current) !== params.baseRevision)
      throw new HelperOpError("conflict", "revision");
    // Positions are those of the text the client sent, secrets still masked: restoring them first would shift the
    // columns after a secret by its length and so tell how long it is.
    const submitted = brokenIssues(params.text);
    if (submitted !== null) return invalid(submitted);
    const prior = priorSecrets(current);
    let restored: string | { refused: number };
    try {
      restored = unmaskModelsJson(params.text, prior.secrets, prior.places, MODELS_CONFIG_TEXT_MAX);
    } catch (error) {
      if (error instanceof JsoncError) return invalid([error.message]);
      if (error instanceof RangeError) return invalid(["text too large"]);
      throw error;
    }
    if (typeof restored !== "string") {
      const { line, column } = lineColumn(params.text, restored.refused);
      return invalid([`masked_value_moved at line ${line}, column ${column}`]);
    }
    if (Buffer.byteLength(restored) > MODELS_CONFIG_TEXT_MAX) return invalid(["text too large"]);
    const issues = await issuesOf(restored, ctx);
    if (issues.length > 0) return invalid(issues);

    return commitText(ctx, params.revisionKey, params.baseRevision, current, restored);
  },
};

export const configGetOp = defineOp(configGet);
export const configSaveOp = defineOp(configSave);
