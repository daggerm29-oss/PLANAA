/**
 * Browser-native voice I/O: Web Speech API recognition in, speechSynthesis out.
 * Both run locally in the browser and cost zero model requests.
 */

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechInputSupported = () => typeof window !== "undefined" && !!ctor();
export const speechOutputSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

export interface ListenHandle {
  stop(): void;
}

/** One utterance: resolves interim text via onInterim, final text via onFinal. */
export function listenOnce(handlers: {
  onInterim?: (t: string) => void;
  onFinal: (t: string) => void;
  onError?: (e: string) => void;
  onEnd?: () => void;
}): ListenHandle | null {
  const C = ctor();
  if (!C) return null;
  const rec = new C();
  rec.lang = navigator.language || "en-US";
  rec.continuous = false;
  rec.interimResults = true;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onInterim?.((finalText + interim).trim());
  };
  rec.onerror = (e) => handlers.onError?.(e.error);
  rec.onend = () => {
    if (finalText.trim()) handlers.onFinal(finalText.trim());
    handlers.onEnd?.();
  };
  try {
    rec.start();
  } catch (e) {
    handlers.onError?.(String((e as Error).message));
    return null;
  }
  return { stop: () => rec.stop() };
}

let cachedVoice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const lang = (navigator.language || "en-US").slice(0, 2);
  const pref = [/Google UK English Female/i, /Microsoft (Aria|Jenny|Sonia|Libby).*Online/i, /Samantha/i, /Google US English/i, /Natural/i];
  for (const re of pref) {
    const v = voices.find((x) => re.test(x.name) && x.lang.startsWith(lang));
    if (v) return (cachedVoice = v);
  }
  return (cachedVoice = voices.find((x) => x.lang.startsWith(lang)) ?? voices[0]);
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => { cachedVoice = null; };
}

/** Strip markdown / ids so the speech sounds natural. Returns a promise resolved when speaking ends. */
export function speak(text: string): Promise<void> {
  if (!speechOutputSupported() || !text.trim()) return Promise.resolve();
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  window.speechSynthesis.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(clean);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.04;
    u.pitch = 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (speechOutputSupported()) window.speechSynthesis.cancel();
}
