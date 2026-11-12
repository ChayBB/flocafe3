/**
 * One shared audio context for KDS alerts. Browsers keep it suspended until the page has been
 * tapped, so the display unlocks it on the first touch.
 * The desktop app's KDS window starts it running.
 */
type AudioContextClass = typeof AudioContext;

// Speakers that have been quiet take a moment to wake, which swallowed the first word ("table").
const AUDIO_WAKE_LEAD_S = 0.7;
const AUDIO_IDLE_MS = 1500;
let lastAudioEndedAt = -Infinity;

let context: AudioContext | null = null;
function getContext(): AudioContext | null {
  if (context || typeof window === 'undefined') return context;
  const AudioCtx: AudioContextClass | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
  if (!AudioCtx) return null;
  try {
    context = new AudioCtx();
  } catch {
    context = null;
  }
  return context;
}

/** Call from a tap or key press: that user gesture is what lets the browser play sound. */
export function unlockKdsAlertSound(): void {
  const audio = getContext();
  if (!audio || audio.state === 'running') return;
  void audio.resume().catch(() => {});
}

/** Short beeps (three by default). Returns false when the browser blocked them, so the caller can alert visually. */
export function playKdsAlert(beeps = 3): boolean {
  const audio = getContext();
  if (!audio || audio.state !== 'running') return false;
  for (let beep = 0; beep < beeps; beep++) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = 880;
    gain.gain.value = 0.15;
    oscillator.connect(gain).connect(audio.destination);
    const start = audio.currentTime + beep * 0.3;
    oscillator.start(start);
    oscillator.stop(start + 0.18);
  }
  // The beeps wake the speaker, so speech right after them needs no wake lead.
  lastAudioEndedAt = Date.now() + ((beeps - 1) * 0.3 + 0.18) * 1000;
  return true;
}

/** The ready-to-serve bells a KDS display can pick from; `none` reads the table without a bell. */
export const KDS_READY_BELLS = {
  hotel: '/sounds/kds-ready-bell.wav',
  ding: '/sounds/kds-ready-ding.wav',
  none: null,
} as const;
export type KdsReadyBell = keyof typeof KDS_READY_BELLS;

const READY_BELL_KEY = 'flocafe:kds-ready-bell';
const READY_BELL_LEAD_MS = 1200;
const readyBells = new Map<KdsReadyBell, Promise<AudioBuffer | null>>();

export function readKdsReadyBell(): KdsReadyBell {
  if (typeof window === 'undefined') return 'hotel';
  try {
    const stored = window.localStorage.getItem(READY_BELL_KEY);
    return stored && stored in KDS_READY_BELLS ? (stored as KdsReadyBell) : 'hotel';
  } catch {
    return 'hotel';
  }
}

export function writeKdsReadyBell(bell: KdsReadyBell): void {
  try {
    window.localStorage.setItem(READY_BELL_KEY, bell);
  } catch {}
}

/** Per-display ready bell delays: for the same table again, and between one table and the next. */
const READY_DELAYS = {
  repeat: { key: 'flocafe:kds-ready-repeat', fallback: 10 },
  gap: { key: 'flocafe:kds-ready-gap', fallback: 0 },
} as const;
export type KdsReadyDelay = keyof typeof READY_DELAYS;
export const KDS_READY_DELAY_MAX = 300;

export function clampKdsReadyDelay(delay: KdsReadyDelay, seconds: number): number {
  if (!Number.isFinite(seconds)) return READY_DELAYS[delay].fallback;
  return Math.min(KDS_READY_DELAY_MAX, Math.max(0, Math.round(seconds)));
}

/** Seconds this display waits for the given ready bell delay. */
export function readKdsReadyDelay(delay: KdsReadyDelay): number {
  const { key, fallback } = READY_DELAYS[delay];
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : clampKdsReadyDelay(delay, Number(stored));
  } catch {
    return fallback;
  }
}

export function writeKdsReadyDelay(delay: KdsReadyDelay, seconds: number): void {
  try {
    window.localStorage.setItem(
      READY_DELAYS[delay].key,
      String(clampKdsReadyDelay(delay, seconds)),
    );
  } catch {}
}

/**
 * Rings this display's ready-to-serve bell and resolves once its strike has sounded, so an
 * announcement can follow; two beeps stand in when the bell cannot be loaded. Resolves at once
 * when sound is blocked.
 */
export async function playKdsReadyBell(bell: KdsReadyBell = readKdsReadyBell()): Promise<void> {
  const audio = getContext();
  const url = KDS_READY_BELLS[bell];
  if (!url || !audio || audio.state !== 'running') return;
  let loading = readyBells.get(bell);
  if (!loading) {
    loading = fetch(url)
      .then((response) =>
        response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status))),
      )
      .then((data) => audio.decodeAudioData(data))
      .catch(() => null);
    readyBells.set(bell, loading);
  }
  const buffer = await loading;
  if (!buffer) {
    readyBells.delete(bell);
    playKdsAlert(2);
    return;
  }
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  source.start();
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(buffer.duration * 1000, READY_BELL_LEAD_MS)),
  );
  lastAudioEndedAt = Date.now();
}

// Silence does not wake a sleeping speaker, so a barely audible low hum plays until the speech starts.
function playWakeSignal(audio: AudioContext, seconds: number): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = 50;
  gain.gain.value = 0.003;
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(audio.currentTime);
  oscillator.stop(audio.currentTime + seconds);
}

/**
 * Before a device voice speaks after a quiet spell: plays the wake hum for the lead, overlapping the
 * start of speech, and resolves once the lead has passed.
 */
export async function wakeKdsSpeaker(): Promise<void> {
  if (Date.now() - lastAudioEndedAt <= AUDIO_IDLE_MS) return;
  const audio = getContext();
  if (!audio) return;
  if (audio.state !== 'running') {
    await Promise.race([
      audio.resume().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    if ((audio.state as AudioContextState) !== 'running') return;
  }
  playWakeSignal(audio, AUDIO_WAKE_LEAD_S + 0.5);
  await new Promise((resolve) => setTimeout(resolve, AUDIO_WAKE_LEAD_S * 1000));
}

/** Records that a device voice has just finished, so speech right after needs no wake lead. */
export function noteKdsSpeechEnded(): void {
  lastAudioEndedAt = Date.now();
}

/** Plays encoded audio (such as a spoken announcement) and resolves when it ends. False when sound is blocked. */
export async function playKdsAudio(data: ArrayBuffer): Promise<boolean> {
  const audio = getContext();
  if (!audio) return false;
  // A display that dozed off may have its audio suspended again; it was unlocked once, so wake it.
  if (audio.state !== 'running') {
    await Promise.race([
      audio.resume().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    if ((audio.state as AudioContextState) !== 'running') return false;
  }
  try {
    const buffer = await audio.decodeAudioData(data);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    const lead = Date.now() - lastAudioEndedAt > AUDIO_IDLE_MS ? AUDIO_WAKE_LEAD_S : 0;
    if (lead > 0) playWakeSignal(audio, lead);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start(audio.currentTime + lead);
    });
    lastAudioEndedAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

const soundFiles = new Map<string, Promise<AudioBuffer | null>>();

/** Plays a bundled sound file once; two beeps stand in when it cannot load. False when sound is blocked. */
export async function playSoundFile(url: string): Promise<boolean> {
  const audio = getContext();
  if (!audio || audio.state !== 'running') return false;
  let loading = soundFiles.get(url);
  if (!loading) {
    loading = fetch(url)
      .then((response) =>
        response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status))),
      )
      .then((data) => audio.decodeAudioData(data))
      .catch(() => null);
    soundFiles.set(url, loading);
  }
  const buffer = await loading;
  if (!buffer) {
    soundFiles.delete(url);
    return playKdsAlert(2);
  }
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  source.start();
  return true;
}
