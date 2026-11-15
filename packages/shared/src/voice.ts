/**
 * 机の音声（docs/design.md「机の音声」）。端末の補助 hangar-voice とサーバが、標準入出力の 1 行 1 JSON で話す約束の型。
 * 画面も VoiceMode と VoicePhase を使う。
 */

/** 聞き方。off は押している間だけ、toggle は丸を押して入れる、always は呼びかけ語と窓。 */
export type VoiceMode = 'off' | 'toggle' | 'always';

/** いまの聞き取りの状態。画面の丸の見せ方が受ける。 */
export type VoicePhase = 'off' | 'ambient' | 'listening' | 'window' | 'meeting';

/** サーバ → 補助（標準入力）。 */
export type VoiceCommand =
  | { cmd: 'listen'; on: boolean }
  | { cmd: 'hints'; context: string }
  | { cmd: 'flush' }
  | { cmd: 'speak'; id: string; text: string; voice: string; speed: number }
  | { cmd: 'stopSpeaking' }
  | { cmd: 'prepare' }
  | { cmd: 'quit' };

export type VoiceModelState = 'missing' | 'downloading' | 'loading' | 'ready' | 'failed';

/** 補助 → サーバ（標準出力）。 */
export type VoiceEvent =
  | { ev: 'ready'; version: string }
  | { ev: 'models'; state: VoiceModelState; progress: number; message?: string }
  | { ev: 'vad'; speech: boolean }
  | { ev: 'segment'; id: string; text: string; dbfs: number; ms: number }
  | { ev: 'flushed' }
  | { ev: 'speaking'; id: string; state: 'start' | 'end' | 'stopped' }
  | { ev: 'micUsers'; bundles: string[] }
  | { ev: 'error'; code: string; message: string };
