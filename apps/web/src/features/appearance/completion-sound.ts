/// <reference lib="dom" />
const TONE_HZ = 880;
const TONE_SECONDS = 0.12;
const TONE_GAIN = 0.1;

let shared: AudioContext | null = null;
let lastToneAt = Number.NEGATIVE_INFINITY;

/** Forgets the lazily built context (tests). */
export function resetCompletionSound(): void {
  shared = null;
  lastToneAt = Number.NEGATIVE_INFINITY;
}

function context(given: AudioContext | undefined): AudioContext | null {
  if (given) return given;
  if (shared) return shared;
  try {
    shared = new AudioContext();
    return shared;
  } catch {
    return null; // no WebAudio, or the browser refused: silence
  }
}

/** Builds the shared context if missing and resumes it if suspended; best effort, never throws. */
export function unlockCompletionSound(): void {
  try {
    const ctx = context(undefined);
    if (ctx?.state === "suspended") ctx.resume().catch(() => undefined);
  } catch {
    // the browser refuses audio: the tone stays best effort
  }
}

/**
 * Unlocks the sound on the first pointerdown or keydown (a reload leaves the context suspended until a gesture).
 * Returns the cleanup that removes the listeners.
 */
export function unlockOnFirstInteraction(): () => void {
  const events = ["pointerdown", "keydown"] as const;
  const off = () => events.forEach((name) => document.removeEventListener(name, fire));
  function fire() {
    off();
    unlockCompletionSound();
  }
  events.forEach((name) => document.addEventListener(name, fire, { once: true }));
  return off;
}

/**
 * A short tone for a run that ended while nobody was looking (M13R21). No audio asset. The context is built on the
 * first unlock (the switch, or the first interaction), after the owner switched the setting on. True only when a tone
 * was scheduled on a running clock; a suspended context gets a resume and no tone. A second call within the tone's
 * length (two panes on one session) is skipped.
 */
export function playCompletion(deps: {
  ctx?: AudioContext;
  enabled: boolean;
  hidden: boolean;
  focused: boolean;
}): boolean {
  if (!deps.enabled || (!deps.hidden && deps.focused)) return false;
  const ctx = context(deps.ctx);
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended") ctx.resume().catch(() => undefined);
    if (ctx.state !== "running") return false;
    if (ctx.currentTime - lastToneAt < TONE_SECONDS) return false;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = TONE_HZ;
    gain.gain.value = TONE_GAIN;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + TONE_SECONDS);
    lastToneAt = ctx.currentTime;
    return true;
  } catch {
    return false;
  }
}
