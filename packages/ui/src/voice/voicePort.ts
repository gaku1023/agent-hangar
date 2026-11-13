/**
 * 音声の口（設計書「机の音声」）。聞く側と話す側を、画面の部品から切り離す。
 * 裏は Web Speech API でも殻の実装でも替えられる。
 */
export type ListenHandlers = {
  /** 認識の途中の文（入力欄にそのまま出す）。 */
  onInterim(text: string): void;
  /** 確定した 1 区切りの文。 */
  onFinal(text: string): void;
  onEnd(): void;
  onError(name: string): void;
};

export type ListenSession = {
  /** 聞くのをやめる。そこまでの結果は届く。 */
  stop(): void;
  /** 聞くのをやめ、結果を捨てる。 */
  abort(): void;
};

export interface VoicePort {
  /** 聞く側と話す側は別々に答える（話すだけ使える、を許す）。 */
  canListen(): boolean;
  canSpeak(): boolean;
  listen(lang: string, handlers: ListenHandlers): ListenSession;
  speak(text: string, lang: string): Promise<void>;
  /** 読み上げを止める。 */
  cancel(): void;
  /** いま読み上げているか。 */
  speaking(): boolean;
  /** 読み上げが最後に自然に終わった時刻（ms、Date.now）。止められたときと一度も読んでいないときは 0。 */
  lastSpokenEnd(): number;
}

/** 確定した文に付ける印。統括は出来事（`[hangar]`）と区別する。 */
export const VOICE_TAG = '[voice]';

/** 読み上げの後に聞く側を閉じておく長さ。自分の声の余韻を拾わないため（spike 15 の実測）。 */
export const ECHO_GUARD_MS = 1500;

/** 確定までの無音の長さ。 */
export const SILENCE_MS = 1200;
