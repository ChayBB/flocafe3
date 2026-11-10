import api from '@/lib/api';
import { noteKdsSpeechEnded, playKdsAudio, wakeKdsSpeaker } from '@/lib/kds-alert-sound';

/** Which sounds this KDS display plays; kept per display like its stage switches. */
export interface KdsSoundSettings {
  /** Speak newly arrived menu items aloud. */
  readAloud: boolean;
  /** Ring and announce a table as its menu items turn ready to serve. */
  orderReady: boolean;
  /** Show a bell button in the message bar that rings the ready bell on demand. */
  showBell: boolean;
  /** Show the message bar and collect its notices; when off, notices are neither kept nor announced. */
  showMessages: boolean;
}

export type KdsSoundSetting = keyof KdsSoundSettings;

const KEY = 'flocafe:kds-sound-settings';
export const DEFAULT_KDS_SOUND_SETTINGS: KdsSoundSettings = {
  readAloud: true,
  orderReady: true,
  showBell: false,
  showMessages: true,
};

export function readKdsSoundSettings(): KdsSoundSettings {
  if (typeof window === 'undefined') return DEFAULT_KDS_SOUND_SETTINGS;
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    const settings = { ...DEFAULT_KDS_SOUND_SETTINGS };
    for (const key of Object.keys(settings) as KdsSoundSetting[]) {
      if (typeof stored?.[key] === 'boolean') settings[key] = stored[key];
    }
    return settings;
  } catch {
    return DEFAULT_KDS_SOUND_SETTINGS;
  }
}

export function writeKdsSoundSettings(settings: KdsSoundSettings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}

const VOICE_WAIT_MS = 1000;
const SPEECH_TIMEOUT_MS = 20000;
let speechQueue: Promise<void> = Promise.resolve();
const serverVoiceMissing = new Set<string>();

const VOICE_KEY = 'flocafe:kds-voice';

/** The display's language for speech: Thai is spoken as th-TH. */
export function kdsSpeechLang(): string {
  if (typeof document === 'undefined') return 'en';
  const lang = document.documentElement.lang || 'en';
  return lang === 'th' ? 'th-TH' : lang;
}

/** The voice this display reads with, by name; empty means pick automatically. */
export function readKdsVoiceName(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(VOICE_KEY) || '';
  } catch {
    return '';
  }
}

export function writeKdsVoiceName(name: string): void {
  try {
    if (name) window.localStorage.setItem(VOICE_KEY, name);
    else window.localStorage.removeItem(VOICE_KEY);
  } catch {}
}

/** Microsoft Edge's online neural voices, e.g. "Microsoft Premwadee Online (Natural) - Thai (Thailand)". */
export function isNaturalVoice(voice: SpeechSynthesisVoice): boolean {
  return /Online \(Natural\)/i.test(voice.name);
}

/** This device's voices for the language, Edge's natural voices first. Browsers list voices late. */
export async function kdsVoicesFor(lang: string): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  const synth = window.speechSynthesis;
  if (synth.getVoices().length === 0) {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, VOICE_WAIT_MS);
      synth.addEventListener?.(
        'voiceschanged',
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  const base = lang.slice(0, 2).toLowerCase();
  return synth
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith(base))
    .sort((a, b) => Number(isNaturalVoice(b)) - Number(isNaturalVoice(a)));
}

// An online browser voice (Edge's "Online (Natural)") reconnects after a quiet spell and cuts the
// start of its first sentence, which was the word "โต๊ะ"; a silent first sentence takes that cut.
const VOICE_WARMUP_IDLE_MS = 20000;
const VOICE_WARMUP_TIMEOUT_MS = 4000;
let lastDeviceSpeechAt = -Infinity;

function utter(
  text: string,
  lang: string,
  voice: SpeechSynthesisVoice,
  volume: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.voice = voice;
    utterance.rate = 0.95;
    utterance.volume = volume;
    let started = false;
    const timer = window.setTimeout(() => {
      done(started);
      if (!started || volume === 0) window.speechSynthesis.cancel();
    }, timeoutMs);
    const done = (spoke: boolean) => {
      window.clearTimeout(timer);
      resolve(spoke);
    };
    utterance.onstart = () => {
      started = true;
    };
    utterance.onend = () => done(true);
    utterance.onerror = () => done(false);
    window.speechSynthesis.speak(utterance);
  });
}

async function speakOnDevice(
  text: string,
  lang: string,
  voice: SpeechSynthesisVoice,
): Promise<boolean> {
  // A browser voice also starts cold, so the speaker is woken first or it swallows the first word.
  await wakeKdsSpeaker();
  if (Date.now() - lastDeviceSpeechAt > VOICE_WARMUP_IDLE_MS) {
    await utter(text.split(/\s+/)[0] || text, lang, voice, 0, VOICE_WARMUP_TIMEOUT_MS);
  }
  const spoke = await utter(text, lang, voice, 1, SPEECH_TIMEOUT_MS);
  lastDeviceSpeechAt = Date.now();
  noteKdsSpeechEnded();
  return spoke;
}

/** The POS computer's voice for the language (a local voice service or Windows), played on this display. */
async function speakFromServer(text: string, lang: string, voice = ''): Promise<boolean> {
  const missingKey = `${voice}\n${lang}`;
  if (serverVoiceMissing.has(missingKey)) return false;
  try {
    const body = voice ? { text, lang, voice } : { text, lang };
    const response = await api.post('/kds/speech', body, { responseType: 'arraybuffer' });
    if (response.status === 204) {
      serverVoiceMissing.add(missingKey);
      return false;
    }
    return await playKdsAudio(response.data as ArrayBuffer);
  } catch {
    return false;
  }
}

/** A voice on the POS computer: a local voice service (such as PyThaiTTS), or `system` for Windows. */
export interface KdsServerVoice {
  id: string;
  name: string;
}

/** Stored voice choices with this prefix name a POS-computer voice rather than a device voice. */
export const KDS_SERVER_VOICE_PREFIX = 'server:';

let serverInfo: Promise<{ engine: string; voices: KdsServerVoice[] }> | null = null;

/** Whether the POS computer runs local voice services ('local') and which ones answer. */
export function kdsServerVoices(
  refresh = false,
): Promise<{ engine: string; voices: KdsServerVoice[] }> {
  if (refresh || !serverInfo) {
    serverInfo = api
      .get('/kds/speech')
      .then((response) => ({
        engine: String(response.data?.engine || 'system'),
        voices: Array.isArray(response.data?.voices)
          ? (response.data.voices as KdsServerVoice[])
          : [],
      }))
      .catch(() => ({ engine: 'system', voices: [] }));
  }
  return serverInfo;
}

/** Stops a read-out at the profanity filter's first ***, dropping the rest of that part. */
export function spokenUntilMaskedWord(text: string): string {
  const masked = text.search(/\*{3,}/);
  const kept = masked === -1 ? text : text.slice(0, masked);
  return kept.replace(/[\s|,:;.\-–—]+$/u, '').trim();
}

/**
 * A POS-computer voice picked on this display; else, unpicked, the POS computer's local voice
 * service when it runs one; else the picked or an Edge natural device voice, else the POS
 * computer's Windows voice, else any voice this device has. A voice that fails falls through.
 */
async function speakNow(rawText: string, lang: string): Promise<void> {
  const text = spokenUntilMaskedWord(rawText);
  if (!text) return;
  const chosenName = readKdsVoiceName();
  if (chosenName.startsWith(KDS_SERVER_VOICE_PREFIX)) {
    if (await speakFromServer(text, lang, chosenName.slice(KDS_SERVER_VOICE_PREFIX.length))) return;
  } else if (
    !chosenName &&
    (await kdsServerVoices()).engine === 'local' &&
    (await speakFromServer(text, lang))
  ) {
    return;
  }
  const voices = await kdsVoicesFor(lang);
  const preferred =
    voices.find((voice) => voice.name === chosenName) ?? voices.find(isNaturalVoice);
  if (preferred && (await speakOnDevice(text, lang, preferred))) return;
  if (await speakFromServer(text, lang)) return;
  const local = voices.find((voice) => voice !== preferred && voice.localService !== false);
  if (local) await speakOnDevice(text, lang, local);
}

/** Runs a sound task after every announcement queued before it. */
export function queueKdsSound(task: () => Promise<void>): void {
  speechQueue = speechQueue.then(task).catch(() => {});
}

/** Reads text aloud now, resolving when it has been read; use inside a queued task. */
export const speakKdsNow = speakNow;

/** Reads text aloud in the given language, one announcement after another. */
export function speakKds(text: string, lang: string): void {
  queueKdsSound(() => speakNow(text, lang));
}
