import { CliError } from "../open-home.ts";
import type { Command } from "../run-cli.ts";
import { UsageError } from "../usage.ts";
import { VERSION } from "../../kernel/version.ts";
import { checkForUpdate, resolveChannel, UpdateFeedError } from "./check.ts";
import type { FetchLike } from "./fetch.ts";

export const CHECK_USAGE = "usage: pap update check [--channel stable|next]";

/** What touches the network or the build; tests replace these. */
export interface CheckSeams {
  fetch?: FetchLike;
  version: string;
}

export function makeCheckCommand(overrides: Partial<CheckSeams> = {}): Command {
  const seams: CheckSeams = { version: VERSION, ...overrides };
  return {
    options: { channel: { type: "string" }, help: { type: "boolean" } },
    async run({ values, positionals, io }) {
      if (values.help === true) {
        io.stdout.write(`${CHECK_USAGE}\n`);
        return 0;
      }
      if (positionals.length > 0) throw new UsageError("update check takes no argument");
      const channel = resolveChannel(typeof values.channel === "string" ? values.channel : undefined, io.env);
      if (channel === null) throw new UsageError("the channel must be stable or next");
      let answer: Awaited<ReturnType<typeof checkForUpdate>>;
      try {
        answer = await checkForUpdate({
          channel,
          current: seams.version,
          ...(seams.fetch === undefined ? {} : { fetch: seams.fetch }),
        });
      } catch (error) {
        if (error instanceof UpdateFeedError)
          throw new CliError(`cannot read the update feed (${error.code})`);
        throw error;
      }
      const { status, feed } = answer;
      io.stdout.write(
        `current: ${seams.version}\nlatest: ${feed.version} (${channel}, published ${feed.publishedAt})\n`,
      );
      if (status === "newer")
        io.stdout.write(
          `an update is available: pap update install\nrelease notes: ${new URL(feed.notes).href}\n`,
        );
      else if (status === "current") io.stdout.write("pap is up to date\n");
      else io.stdout.write("this pap is newer than the feed\n");
      return 0;
    },
  };
}

export const updateCheck: Command = makeCheckCommand();
