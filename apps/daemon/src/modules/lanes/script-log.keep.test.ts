import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { openLog } from "./script-log.ts";
import { tempHome } from "./testing/script-fakes.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.dispose());

const logger = captureLogger().logger;
const path = () => join(home.dir, "lanes", "lane-aaaa", "setup.log");
const put = (text: string, keep?: boolean) => {
  const sink = openLog(home.dir, "lane-aaaa", "setup", logger, keep);
  sink.write(Buffer.from(text));
  sink.close();
};

describe("openLog keeping the earlier lines (the copy log of a lane's first setup)", () => {
  it("replaces the kind's log by default (M9R29)", () => {
    put("copy line\n");
    put("script\n");
    expect(readFileSync(path(), "utf8")).toBe("script\n");
  });

  it("appends after the earlier lines when asked to keep them, with the same 0600 mode", () => {
    put("copy line\n");
    put("script\n", true);
    expect(readFileSync(path(), "utf8")).toBe("copy line\nscript\n");
    expect(statSync(path()).mode & 0o777).toBe(0o600);
  });

  it("creates the file when there is nothing to keep", () => {
    put("script\n", true);
    expect(readFileSync(path(), "utf8")).toBe("script\n");
  });
});
