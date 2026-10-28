import { randomBytes } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import { join } from "node:path";
import {
  HELPER_OPS,
  TEMPLATE_LIMITS,
  type TemplatesSaveParams,
  type TemplateWriteResult,
} from "@pap/contracts/pi-host";
import { defineOp, HelperOpError, type HelperContext } from "../ops.ts";

const FOLDER = "prompts";
const UNSAFE_LINE = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]|\p{Bidi_Control}/gu;
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** What Pi reads: one `description` line, JSON-quoted (a YAML double-quoted scalar), then the body exactly as typed (UX1-R3). */
export function templateText(name: string, body: string, description: string | undefined): string {
  const clean = (text: string): string =>
    Array.from(text.replace(UNSAFE_LINE, " ").trim()).slice(0, TEMPLATE_LIMITS.description).join("");
  const first = body
    .split("\n")
    .map(clean)
    .find((line) => line !== "");
  const line = clean(description ?? "") || first || name;
  return `---\ndescription: ${JSON.stringify(line)}\n---\n${body}`;
}

/**
 * Writes `<agent dir>/prompts/<name>.md` (UX1-R6). The folder is opened without following a link and must be this user's
 * directory; on Linux its descriptor must still name it. The text goes to an exclusive 0600 temporary file beside it, then
 * `link` (no replace: atomic, a name that appeared since the check is `conflict`) or `rename` (replace: the name itself
 * is replaced, never what a link points at). A non-regular or hard-linked target is refused. Residual, as in
 * `pi-file.ts`: another process of the same user can swap a parent folder between the descriptor check and the final step.
 */
export async function writeTemplate(
  ctx: Pick<HelperContext, "agentDir">,
  params: TemplatesSaveParams,
  hooks: { readonly lstat?: (path: string) => Promise<Stats> } = {},
): Promise<TemplateWriteResult> {
  const agentDir = await fs.realpath(ctx.agentDir);
  const folder = join(agentDir, FOLDER);
  try {
    await fs.mkdir(folder, { mode: 0o700 });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  const dir = await fs
    .open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch((error: unknown) => {
      if (errno(error) === "ELOOP" || errno(error) === "ENOTDIR")
        throw new HelperOpError("config_path_refused", "prompts is not a folder");
      throw error;
    });
  try {
    const info = await dir.stat();
    if (!info.isDirectory() || info.uid !== process.getuid?.())
      throw new HelperOpError("config_path_refused", "prompts folder");
    if (
      process.platform === "linux" &&
      (await fs.readlink(`/proc/self/fd/${dir.fd}`).catch(() => null)) !== folder
    )
      throw new HelperOpError("config_path_refused", "prompts folder moved");
    const target = join(folder, `${params.name}.md`);
    const existing = await (hooks.lstat ?? fs.lstat)(target).catch((error: unknown) => {
      if (errno(error) === "ENOENT") return null;
      throw error;
    });
    if (existing !== null && params.replace !== true) throw new HelperOpError("conflict");
    if (existing !== null && !existing.isFile())
      throw new HelperOpError("config_path_refused", "not a regular file");
    if (existing !== null && existing.nlink > 1) throw new HelperOpError("config_hard_link");
    const temp = join(folder, `.${params.name}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await fs.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NOCTTY,
      0o600,
    );
    try {
      try {
        await handle.writeFile(templateText(params.name, params.body, params.description), "utf8");
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (existing !== null) await fs.rename(temp, target);
      else {
        try {
          await fs.link(temp, target);
        } catch (error) {
          if (errno(error) === "EEXIST") throw new HelperOpError("conflict");
          throw error;
        }
        await fs.rm(temp, { force: true });
      }
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined); // the first error is the one the daemon needs
      throw error;
    }
    await dir.sync().catch(() => undefined); // the file is in place; a folder sync only guards a power cut
    return { replaced: existing !== null };
  } finally {
    await dir.close().catch(() => undefined);
  }
}

export const templateWriteOp = defineOp({
  params: HELPER_OPS["templates.write"].params,
  run: (params, ctx) => writeTemplate(ctx, params),
});
