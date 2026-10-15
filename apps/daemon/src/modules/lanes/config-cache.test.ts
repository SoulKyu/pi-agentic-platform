import { describe, expect, it } from "vitest";
import { CONFIG_CACHE_MAX, createConfigCache, type FileKey } from "./config-cache.ts";
import type { ConfigRead } from "./project-config.ts";

const key = (over: Partial<FileKey> = {}): FileKey => ({ dev: 1, ino: 2, size: 3, mtimeMs: 4, ...over });
const answer = (setup: string): ConfigRead => ({ ok: true, config: { setup }, warnings: [] });

describe("config cache", () => {
  it("does not read again for the same (dev, ino, size, mtimeMs)", async () => {
    const cache = createConfigCache();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return answer("a");
    };
    expect(await cache.get("/p", key(), read)).toEqual(answer("a"));
    expect(await cache.get("/p", key(), read)).toEqual(answer("a"));
    expect(reads).toBe(1);
  });

  it("reads again when any part of the key changes", async () => {
    const cache = createConfigCache();
    let reads = 0;
    const read = async () => answer(String(++reads));
    await cache.get("/p", key(), read);
    for (const over of [{ mtimeMs: 5 }, { size: 9 }, { ino: 7 }, { dev: 8 }]) {
      const before = reads;
      await cache.get("/p", key(over), read);
      expect(reads, JSON.stringify(over)).toBe(before + 1);
      await cache.get("/p", key(), read); // back to the first key: the slot holds the latest only
    }
  });

  it("keeps one entry per project root", async () => {
    const cache = createConfigCache();
    let reads = 0;
    const read = async () => answer(String(++reads));
    await cache.get("/a", key(), read);
    await cache.get("/b", key(), read);
    await cache.get("/a", key(), read);
    expect(reads).toBe(2);
  });

  it("drops the oldest root at the 65th and never grows past 64", async () => {
    expect(CONFIG_CACHE_MAX).toBe(64);
    const cache = createConfigCache();
    let reads = 0;
    const read = async () => answer(String(++reads));
    for (let at = 0; at < 65; at += 1) await cache.get(`/p${at}`, key(), read);
    expect(cache.size()).toBe(64);
    expect(reads).toBe(65);
    await cache.get("/p64", key(), read); // newest: still cached
    expect(reads).toBe(65);
    await cache.get("/p0", key(), read); // oldest: evicted, read again
    expect(reads).toBe(66);
  });

  it("does not cache a failed read", async () => {
    const cache = createConfigCache();
    await expect(cache.get("/p", key(), () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cache.size()).toBe(0);
  });
});
