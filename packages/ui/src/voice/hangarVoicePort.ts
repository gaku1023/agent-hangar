import type { VoiceStateDto } from '@agent-hangar/shared';
import type { ListenSession, VoicePort } from './voicePort.ts';

type SpeakApi = { voiceSpeak(id: string, text: string): Promise<unknown>; voiceStop(): Promise<unknown> };

/** 補助（hangar-voice）につなぐ口。状態は事象 voice.state から update で受ける。 */
export type HangarVoicePort = VoicePort & { update(state: VoiceStateDto | null): void };

/**
 * VoicePort をサーバの口（POST /api/voice/*）で実装する。
 * 聞く側は丸（VoicePill）が hold と toggle で直接動かすので、listen は何もしない。
 * speaking と lastSpokenEnd は voice.state の speakingId から作る。
 */
export function hangarVoicePort(api: SpeakApi, now: () => number = Date.now): HangarVoicePort {
  let state: VoiceStateDto | null = null;
  let lastEnd = 0;
  let seq = 0;
  const noop: ListenSession = { stop() {}, abort() {} };
  return {
    update(next) {
      if (state?.speakingId && !next?.speakingId) lastEnd = now();
      state = next;
    },
    canListen: () => state?.available === true,
    canSpeak: () => state?.available === true,
    listen(_lang, h) { h.onEnd(); return noop; },
    speak(text) {
      seq += 1;
      return api.voiceSpeak(`ui-${seq}`, text).then(() => undefined, () => undefined);
    },
    cancel() {
      lastEnd = 0;
      void api.voiceStop().catch(() => {});
    },
    speaking: () => !!state?.speakingId,
    lastSpokenEnd: () => lastEnd,
  };
}
