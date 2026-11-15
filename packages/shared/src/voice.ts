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

const MODEL_STATES: readonly VoiceModelState[] = ['missing', 'downloading', 'loading', 'ready', 'failed'];
const SPEAKING_STATES = ['start', 'end', 'stopped'];
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 補助の 1 行が約束（VoiceEvent）の形か。ev ごとに中身の型まで見る。
 * 補助は別のプロセスで、壊れた行や古い版の行を出しうる。形の合わない行は捨て、サーバが読み違えて落ちないようにする。
 */
export function isVoiceEvent(v: unknown): v is VoiceEvent {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  switch (o.ev) {
    case 'ready': return isStr(o.version);
    case 'models': return isStr(o.state) && (MODEL_STATES as readonly string[]).includes(o.state) && isNum(o.progress) && (o.message === undefined || isStr(o.message));
    case 'vad': return typeof o.speech === 'boolean';
    case 'segment': return isStr(o.id) && isStr(o.text) && isNum(o.dbfs) && isNum(o.ms);
    case 'flushed': return true;
    case 'speaking': return isStr(o.id) && isStr(o.state) && SPEAKING_STATES.includes(o.state);
    case 'micUsers': return Array.isArray(o.bundles) && o.bundles.every(isStr);
    case 'error': return isStr(o.code) && isStr(o.message);
    default: return false;
  }
}

/** 人格。呼びかけ語の名前と読み、統括の口調、読み上げの声と速さ。声は `os:<識別子>` か `kokoro:<声>`。 */
export type VoicePersona = { id: string; name: string; reading: string; tone: string; voice: string; speed: number };

/** 設定の voice。この PC だけで、同期しない。 */
export type VoiceSetting = { mode: VoiceMode; personaId: string; personas: VoicePersona[]; asrModel?: string };

export const DEFAULT_VOICE_PERSONA: VoicePersona = { id: 'default', name: 'ハンガー', reading: 'はんがー', tone: '', voice: 'kokoro:jf_alpha', speed: 1.2 };
export const DEFAULT_VOICE: VoiceSetting = { mode: 'off', personaId: DEFAULT_VOICE_PERSONA.id, personas: [DEFAULT_VOICE_PERSONA] };

const MODES: readonly VoiceMode[] = ['off', 'toggle', 'always'];
export const isVoiceMode = (v: unknown): v is VoiceMode => typeof v === 'string' && (MODES as readonly string[]).includes(v);
const isVoiceId = (v: unknown): v is string => typeof v === 'string' && /^(os|kokoro):\S+$/.test(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const charLen = (s: string): number => Array.from(s).length;
const CONTROL = /\p{Cc}/u;

/**
 * 人格の値の決まり。名前と読みは呼びかけ語と統括の指示文に、口調は統括の指示文に入るので、改行や制御文字で指示文の形を崩させない。
 * 名前は 1〜20 文字、読みはひらがな（ー を含む）2〜20 文字か空（空なら呼びかけ語は効かない）、どちらも改行と制御文字は不可。
 * 口調は 300 文字まで、改行は 3 つまでで、ほかの制御文字は不可。
 */
const isPersonaName = (s: string): boolean => charLen(s) >= 1 && charLen(s) <= 20 && !CONTROL.test(s);
const isPersonaReading = (s: string): boolean => s === '' || /^[\u3041-\u3096\u309d\u309eー]{2,20}$/u.test(s);
const isPersonaTone = (s: string): boolean => charLen(s) <= 300 && !CONTROL.test(s.replace(/\n/g, '')) && (s.match(/\n/g)?.length ?? 0) <= 3;

/**
 * 人格を読む。strict（設定の API）は決まりに合わない値があれば null を返す。
 * strict でない（設定のファイルを読むとき）は、合わない読みと口調を空に戻し、名前が合わなければその人格を捨てる。
 */
function personaOf(raw: unknown, strict = false): VoicePersona | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id)?.trim();
  const name = str(o.name)?.trim();
  if (!id || name === undefined || !isPersonaName(name)) return null;
  const reading = 'reading' in o && o.reading !== undefined ? str(o.reading)?.trim() ?? null : '';
  const tone = 'tone' in o && o.tone !== undefined ? str(o.tone)?.trim() ?? null : '';
  const readingOk = reading !== null && isPersonaReading(reading);
  const toneOk = tone !== null && isPersonaTone(tone);
  if (strict && (!readingOk || !toneOk)) return null;
  const speed = typeof o.speed === 'number' && Number.isFinite(o.speed) && o.speed >= 0.5 && o.speed <= 2 ? o.speed : DEFAULT_VOICE_PERSONA.speed;
  return {
    id, name,
    reading: readingOk ? reading : '',
    tone: toneOk ? tone : '',
    voice: isVoiceId(o.voice) ? o.voice : DEFAULT_VOICE_PERSONA.voice,
    speed,
  };
}

/** 手で書き換えた値と古い設定を、既定に寄せて読む。知らない値は既定に戻す。 */
export function voiceOf(raw: unknown): VoiceSetting {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const personas: VoicePersona[] = [];
  for (const p of Array.isArray(o.personas) ? o.personas : []) {
    const v = personaOf(p);
    if (v && !seen.has(v.id)) { seen.add(v.id); personas.push(v); }
  }
  if (personas.length === 0) personas.push({ ...DEFAULT_VOICE_PERSONA });
  const personaId = typeof o.personaId === 'string' && seen.has(o.personaId) ? o.personaId : personas[0]!.id;
  const asr = typeof o.asrModel === 'string' && o.asrModel.trim() !== '' ? o.asrModel.trim() : null;
  return { mode: isVoiceMode(o.mode) ? o.mode : DEFAULT_VOICE.mode, personaId, personas, ...(asr ? { asrModel: asr } : {}) };
}

/** 使っている人格。 */
export function activePersona(v: VoiceSetting): VoicePersona {
  return v.personas.find((p) => p.id === v.personaId) ?? v.personas[0] ?? DEFAULT_VOICE_PERSONA;
}

/** 設定の API が受ける voice。形が合わなければ偽（知らない値を黙って既定に戻さず、書く側には断る）。 */
export function isVoicePatch(v: unknown): v is Partial<VoiceSetting> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0 || keys.some((k) => !['mode', 'personaId', 'personas', 'asrModel'].includes(k))) return false;
  if ('mode' in o && !isVoiceMode(o.mode)) return false;
  if ('personaId' in o && typeof o.personaId !== 'string') return false;
  if ('asrModel' in o && typeof o.asrModel !== 'string') return false;
  if ('personas' in o) {
    if (!Array.isArray(o.personas) || o.personas.length === 0 || o.personas.some((p) => personaOf(p, true) === null)) return false;
  }
  return true;
}

/** 画面が受ける、声のいまの状態（GET /api/voice と事象 voice.state）。 */
export type VoiceStateDto = {
  available: boolean;
  models: { state: VoiceModelState; progress: number };
  mode: VoiceMode;
  phase: VoicePhase;
  caption: string | null;
  speakingId: string | null;
  meeting: boolean;
  /** 使っている人格に読みがあり、呼びかけ語で呼べるか。読みが空の人格では、常に聞くにしても呼べない。 */
  callable: boolean;
};
