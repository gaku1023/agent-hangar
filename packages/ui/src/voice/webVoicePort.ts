import type { Language } from '@agent-hangar/shared';
import type { ListenHandlers, ListenSession, VoicePort } from './voicePort.ts';

export const speechLang = (lang: string): string => (lang === 'ja' ? 'ja-JP' : 'en-US');

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
};
type RecognitionCtor = new () => Recognition;

/** Web Speech API の実装。webkitSpeechRecognition と speechSynthesis が無い側は「使えない」と答える。 */
export function webVoicePort(win: Window = window): VoicePort {
  const w = win as unknown as { webkitSpeechRecognition?: RecognitionCtor; SpeechRecognition?: RecognitionCtor; speechSynthesis?: SpeechSynthesis; SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance };
  const Ctor = w.webkitSpeechRecognition ?? w.SpeechRecognition;
  const synth = w.speechSynthesis;
  const Utter = w.SpeechSynthesisUtterance;
  let busy = false;
  let lastEnd = 0;
  return {
    canListen: () => Ctor !== undefined,
    canSpeak: () => synth !== undefined && Utter !== undefined,
    listen(lang: Language | string, h: ListenHandlers): ListenSession {
      if (!Ctor) { h.onError('unavailable'); h.onEnd(); return { stop() {}, abort() {} }; }
      const r = new Ctor();
      let aborted = false;
      r.lang = speechLang(lang);
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e) => {
        if (aborted) return;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i]!;
          const text = res[0]?.transcript ?? '';
          if (res.isFinal) h.onFinal(text); else h.onInterim(text);
        }
      };
      r.onerror = (e) => { if (!aborted) h.onError(e.error); };
      r.onend = () => { if (!aborted) h.onEnd(); };
      try { r.start(); } catch { h.onError('start-failed'); }
      return { stop: () => r.stop(), abort: () => { aborted = true; r.abort(); } };
    },
    speak(text, lang) {
      if (!synth || !Utter) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const u = new Utter(text);
        u.lang = speechLang(lang);
        u.onstart = () => { busy = true; };
        u.onend = () => { busy = false; lastEnd = Date.now(); resolve(); };
        u.onerror = () => { busy = false; resolve(); };
        busy = true;
        synth.speak(u);
      });
    },
    cancel() {
      busy = false;
      lastEnd = 0;
      synth?.cancel();
    },
    speaking: () => busy || (synth?.speaking ?? false),
    lastSpokenEnd: () => lastEnd,
  };
}
