import type { ListenHandlers, ListenSession, VoicePort } from './voicePort.ts';

/** 試験用の偽の VoicePort。聞く・話すの呼びを記録し、認識の結果は試験が手で流す。 */
export class FakeVoicePort implements VoicePort {
  canListenNow = true;
  canSpeakNow = true;
  isSpeaking = false;
  lastEnd = 0;
  readonly calls: string[] = [];
  handlers: ListenHandlers | null = null;
  listening = false;

  canListen() { return this.canListenNow; }
  canSpeak() { return this.canSpeakNow; }
  speaking() { return this.isSpeaking; }
  lastSpokenEnd() { return this.lastEnd; }
  listen(lang: string, handlers: ListenHandlers): ListenSession {
    this.calls.push(`listen:${lang}`);
    this.handlers = handlers;
    this.listening = true;
    return {
      stop: () => { this.calls.push('stop'); this.listening = false; handlers.onEnd(); },
      abort: () => { this.calls.push('abort'); this.listening = false; },
    };
  }
  speak(text: string, lang: string): Promise<void> {
    this.calls.push(`speak:${lang}:${text}`);
    this.isSpeaking = true;
    return Promise.resolve();
  }
  cancel() { this.calls.push('cancel'); this.isSpeaking = false; this.lastEnd = 0; }
  /** 読み上げが終わったことにする。 */
  finishSpeaking(now: number) { this.isSpeaking = false; this.lastEnd = now; }
}
