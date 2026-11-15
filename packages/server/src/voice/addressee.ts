import type { OrchestratorOrigin, VoiceMode, VoicePhase } from '@agent-hangar/shared';
import { fold } from './hints.ts';

/**
 * 誰宛てかの状態機械（docs/design.md「机の音声」、計画の「誰宛てかの決まり」）。
 * 時計を中に持たず、各入力の at と tick で時間を判定する純粋な関数にする。
 * 由来の強弱で統括の権限が変わるため、迷う所は弱い側と送らない側に倒す。
 * 送る文には印を付けない。印はサーバの markOrchestratorText が付ける。
 */

/** 呼びかけ語だけを言った後、次の区間を呼ばれたものとして受ける長さ。 */
export const CALLED_MS = 8000;
/** 強い由来のターンの返答の後に開く窓の長さ。 */
export const WINDOW_MS = 10000;

const CALL_HEADS = ['ねえ', 'ねー', 'ねぇ'];
const STOP_WORDS = new Set(['止めて', '止めろ', 'とめて', 'ストップ', 'すとっぷ'].map(fold));
const LEADING_PUNCT = /^[\p{P}\p{S}\s]+/u;

export type AddrInput =
  | { kind: 'segment'; text: string; at: number }
  | { kind: 'holdStart' | 'holdEnd' | 'toggleOn' | 'toggleOff'; at: number }
  | { kind: 'replied'; at: number }
  | { kind: 'meeting'; on: boolean; at: number }
  | { kind: 'tick'; at: number };

export type AddrOutput = { send?: { text: string; origin: OrchestratorOrigin }; stopSpeaking?: boolean; phase: VoicePhase };

export type AddrState = {
  /** 押している間か。 */
  held: boolean;
  /** 押している間に来た区間（来た順）。 */
  heldTexts: string[];
  /** 切り替えが入っているか。 */
  toggled: boolean;
  /** 切り替えを入れてから、まだ 1 回も送っていないか。 */
  toggleFirst: boolean;
  /** 呼びかけ語だけを言った後、次の区間を受ける期限（この時刻を含まない）。 */
  calledUntil: number | null;
  /** 窓の期限（この時刻を含まない）。 */
  windowUntil: number | null;
  /** 最後に送ったのが強い由来で、まだ返答が来ていないか。来たら窓を開く。 */
  awaitingStrongReply: boolean;
  /** 会議中か。 */
  meeting: boolean;
};

export function initialAddrState(): AddrState {
  return { held: false, heldTexts: [], toggled: false, toggleFirst: false, calledUntil: null, windowUntil: null, awaitingStrongReply: false, meeting: false };
}

export function isWindowOpen(state: AddrState, at: number): boolean {
  return state.windowUntil !== null && at < state.windowUntil;
}

/**
 * 区間の文の頭が「ねえ＋名前の読み」なら、その後ろの残り（頭の句読点と空白を除く）を返す。呼ばれていなければ null。
 * 比べるのはひらがなに寄せ、句読点と空白を除いた形で、返す残りは元の文から切り出す。
 */
export function matchCall(text: string, callReading: string): string | null {
  const reading = fold(callReading);
  if (reading === '') return null;
  const folded = fold(text);
  const head = CALL_HEADS.map((h) => h + reading).find((p) => folded.startsWith(p));
  if (head === undefined) return null;
  const chars = Array.from(text);
  let i = 0;
  while (i < chars.length && fold(chars.slice(0, i).join('')).length < head.length) i++;
  return chars.slice(i).join('').replace(LEADING_PUNCT, '').trim();
}

const isStopWord = (text: string) => STOP_WORDS.has(fold(text));

type Cfg = { mode: VoiceMode; callReading: string; speaking: boolean };

export function addressee(state: AddrState, input: AddrInput, cfg: Cfg): [AddrState, AddrOutput] {
  const s = expire(state, input.at);
  let send: AddrOutput['send'];
  let stopSpeaking: boolean | undefined;

  switch (input.kind) {
    case 'holdStart':
      s.held = true;
      s.heldTexts = [];
      break;
    case 'holdEnd': {
      if (!s.held) break;
      const text = s.heldTexts.join(' ').trim();
      s.held = false;
      s.heldTexts = [];
      if (text !== '') send = { text, origin: 'voice-held' };
      break;
    }
    case 'toggleOn':
      if (cfg.mode !== 'toggle' || s.toggled) break;
      s.toggled = true;
      s.toggleFirst = true;
      break;
    case 'toggleOff':
      s.toggled = false;
      s.toggleFirst = false;
      break;
    case 'meeting':
      s.meeting = input.on;
      if (input.on) {
        s.windowUntil = null;
        s.calledUntil = null;
        s.awaitingStrongReply = false;
      }
      break;
    case 'replied':
      if (s.awaitingStrongReply && cfg.mode === 'always' && !s.meeting) s.windowUntil = input.at + WINDOW_MS;
      s.awaitingStrongReply = false;
      break;
    case 'tick':
      break;
    case 'segment': {
      const text = input.text.trim();
      if (text === '') break;
      if (cfg.speaking && isStopWord(text)) {
        stopSpeaking = true;
        break;
      }
      if (s.held) {
        s.heldTexts = [...s.heldTexts, text];
        break;
      }
      if (cfg.mode === 'toggle') {
        if (!s.toggled) break;
        send = { text, origin: s.toggleFirst ? 'voice-toggle-first' : 'voice-toggle-rest' };
        s.toggleFirst = false;
        break;
      }
      if (cfg.mode !== 'always' || s.meeting) break;
      const rest = matchCall(text, cfg.callReading);
      if (rest !== null) {
        s.windowUntil = null;
        if (rest === '') s.calledUntil = input.at + CALLED_MS;
        else {
          s.calledUntil = null;
          send = { text: rest, origin: 'voice-called' };
        }
      } else if (s.calledUntil !== null) {
        s.calledUntil = null;
        send = { text, origin: 'voice-called' };
      } else if (s.windowUntil !== null) {
        // 窓の区間は 1 回だけ送り、窓を閉じる。続きは呼びかけ語か押している間で受ける。
        s.windowUntil = null;
        send = { text, origin: 'voice-window' };
      }
      break;
    }
  }

  if (send) s.awaitingStrongReply = isStrong(send.origin);
  if (cfg.mode !== 'toggle') {
    s.toggled = false;
    s.toggleFirst = false;
  }
  if (cfg.mode !== 'always') {
    // 常に聞くを外したら、呼ばれた後の待ちと窓を残さない。戻したときに古い窓で送らないため。
    s.calledUntil = null;
    s.windowUntil = null;
  }
  return [s, { ...(send ? { send } : {}), ...(stopSpeaking ? { stopSpeaking } : {}), phase: phaseOf(s, cfg.mode) }];
}

function isStrong(origin: OrchestratorOrigin): boolean {
  return origin === 'voice-held' || origin === 'voice-called' || origin === 'voice-toggle-first';
}

/** 期限を過ぎた待ちと窓を閉じた写しを返す。 */
function expire(state: AddrState, at: number): AddrState {
  const s = { ...state, heldTexts: [...state.heldTexts] };
  if (s.calledUntil !== null && at >= s.calledUntil) s.calledUntil = null;
  if (s.windowUntil !== null && at >= s.windowUntil) s.windowUntil = null;
  return s;
}

function phaseOf(s: AddrState, mode: VoiceMode): VoicePhase {
  if (s.held || (mode === 'toggle' && s.toggled)) return 'listening';
  if (mode !== 'always') return 'off';
  if (s.meeting) return 'meeting';
  if (s.calledUntil !== null) return 'listening';
  if (s.windowUntil !== null) return 'window';
  return 'ambient';
}
