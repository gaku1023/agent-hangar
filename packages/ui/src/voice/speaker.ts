import type { VoicePort } from './voicePort.ts';

/**
 * 読み上げの口。返答の文を渡すと speak する。どの返答を読むかは呼び手（統括の柱）が決める。
 * 試験では port に FakeVoicePort を渡して差し替える。
 */
export type Speaker = { speak(text: string): void; stop(): void };

export function createSpeaker(port: VoicePort, lang: () => string): Speaker {
  return {
    speak(text) {
      if (!port.canSpeak() || text.trim() === '') return;
      // 重ねて鳴らさない。新しい文が来たら、読んでいるものを止めてから読む。
      if (port.speaking()) port.cancel();
      void port.speak(text, lang());
    },
    stop() {
      if (port.canSpeak()) port.cancel();
    },
  };
}
