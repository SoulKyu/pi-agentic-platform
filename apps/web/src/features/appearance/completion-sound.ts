/// <reference lib="dom" />
const TONE_HZ = 880;
const TONE_SECONDS = 0.12;
const TONE_GAIN = 0.1;

let shared: AudioContext | null = null;

/** Forgets the lazily built context (tests). */
export function resetCompletionSound(): void {
  shared = null;
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

/**
 * A short tone for a run that ended while nobody was looking (M13R21). No audio asset. The context is built on the
 * first tone, after the owner switched the setting on; a suspended one is resumed and the tone is scheduled on it.
 * True when a tone was started.
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
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = TONE_HZ;
    gain.gain.value = TONE_GAIN;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + TONE_SECONDS);
    return true;
  } catch {
    return false;
  }
}
