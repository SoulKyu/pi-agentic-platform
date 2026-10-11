// A test-only preload (`NODE_OPTIONS=--import <this file>`): the worker reports `health` every 30 s, which a test
// cannot wait for, so an interval of exactly that length runs every 100 ms in a worker started with it.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((handler: () => void, ms?: number) =>
  realSetInterval(handler, ms === 30_000 ? 100 : ms)) as typeof setInterval;
