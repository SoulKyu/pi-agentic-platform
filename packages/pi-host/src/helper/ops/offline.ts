/**
 * Pi resolves the packages named in `settings.json` while it loads resources, and installs a missing one (`npm install`
 * with scripts, or `git clone`) unless `PI_OFFLINE` is set. A read must never install anything (MC52): this runs `run`
 * with Pi's own offline switch on, then puts the variable back. Only an explicit install or update op may go online.
 */
export async function offline<T>(run: () => Promise<T>): Promise<T> {
  const before = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = before;
  }
}
