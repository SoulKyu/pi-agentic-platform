import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { type Logger, silentLogger } from "../../../kernel/logger.ts";
import { createRateLimiter } from "../../../kernel/rate-limit.ts";
import { type FakeScanPort, fakeScanPort } from "./fake-scan-port.ts";

export const INSTALLED_AT = Date.parse("2026-10-12T00:00:00Z");

export const header = (id = "sess-1", timestamp = "2026-10-12T10:00:00.000Z") =>
  JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/w/api" });
export const user = (id: string, text: string) =>
  JSON.stringify({ type: "message", id, message: { role: "user", content: text } });
export const assistant = (id: string, text: string) =>
  JSON.stringify({
    type: "message",
    id,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
export const info = (name: string) => JSON.stringify({ type: "session_info", name });
export const piFile = (head: string, ...entries: string[]): string => `${[head, ...entries].join("\n")}\n`;

/** The shape of the scanner's `FileContext`, spelled here because a test helper imports no module internals. */
export interface BedContext<S> {
  readonly installedAt: number;
  readonly store: S;
  readonly sessions: FakeScanPort["port"];
  readonly logger: Logger;
  say(event: string, fields?: Record<string, unknown>): void;
  readonly limits?: { readonly stepBytes?: number; readonly maxIndexedChars?: number };
}

export interface ScannerBed<S, O> {
  readonly dir: string;
  readonly sessionsDir: string;
  readonly db: Db;
  readonly store: S;
  readonly port: FakeScanPort;
  context(limits?: BedContext<S>["limits"], patch?: Partial<BedContext<S>>): BedContext<S>;
  file(name: string, text: string): string;
  said(event: string): Array<{ msg: string; fields: Record<string, unknown> | undefined }>;
  run(path: string, limits?: BedContext<S>["limits"]): O;
}

/** A temporary agent directory, a real search.db and a fake sessions port, fresh for each test of the calling file. */
export function useScannerBed<S, O>(deps: {
  openSearchIndex(path: string, logger: Logger): Db;
  createSearchIndexStore(db: Db): S;
  processFile(path: string, ctx: BedContext<S>): O;
}): ScannerBed<S, O> {
  const { openSearchIndex, createSearchIndexStore, processFile } = deps;
  let dir = "";
  let sessionsDir = "";
  let db: Db;
  let store: S;
  let port: FakeScanPort;
  let limiter = createRateLimiter(createFakeClock(), 60_000);
  let warnings: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (msg, fields) => {
      warnings.push({ msg, fields });
    },
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-scanner-file-"));
    sessionsDir = join(dir, "sessions", "--w--");
    mkdirSync(sessionsDir, { recursive: true });
    db = openSearchIndex(join(dir, "search.db"), silentLogger);
    store = createSearchIndexStore(db);
    port = fakeScanPort();
    warnings = [];
    limiter = createRateLimiter(createFakeClock(), 60_000);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const context: ScannerBed<S, O>["context"] = (limits, patch = {}) => ({
    installedAt: INSTALLED_AT,
    store,
    sessions: port.port,
    logger,
    say: (event, fields) => {
      if (limiter.check(event).allowed) logger.warn(event, fields);
    },
    ...(limits ? { limits } : {}),
    ...patch,
  });
  return {
    get dir() {
      return dir;
    },
    get sessionsDir() {
      return sessionsDir;
    },
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    get port() {
      return port;
    },
    context,
    file: (name, text) => {
      const path = join(sessionsDir, name);
      writeFileSync(path, text);
      return path;
    },
    said: (event) => warnings.filter((w) => w.msg === event),
    run: (path, limits) => processFile(path, context(limits)),
  };
}
