import { isEffort } from './launchChoices.ts';
import { isModelName } from './summaryEngine.ts';

/**
 * 統括（全セッションを統括する常駐の会話、docs/design.md「統括」）の設定。この PC だけの設定で、同期しない。
 * enabled を入れた PC が宿主になる。sessionId は宿主が起こした会話の id で、見張り（OrchestratorKeeper）だけが書く。
 * model と effort は統括を起こすたびに渡す。既定は Sonnet と medium（用途ごとには分けない）。
 */
export type OrchestratorSetting = { enabled: boolean; sessionId: string | null; model: string; effort: string };

export const DEFAULT_ORCHESTRATOR: OrchestratorSetting = { enabled: false, sessionId: null, model: 'sonnet', effort: 'medium' };

/** 統括の印。SessionDto.role と LiveSessionDto.role が持つ。ほかの会話には付けない。 */
export type SessionRole = 'orchestrator';

/**
 * 統括へ送る文の由来（docs/design.md「統括」の安全の境界と「机の音声」）。端末は本文と由来を送り、印はサーバが付ける。
 * - typed：打鍵。印を付けない。
 * - 強い声（voice-held、voice-called、voice-toggle-first）：押している間、呼びかけ語つき、ショートカットで聞くを入れて最初の発話。`[voice]` を付ける。
 * - 弱い声（voice-window、voice-toggle-rest）：返答の直後の窓、ショートカットで入れたままの 2 つ目以降。`[voice:window]` を付け、読むことと自分の記録だけに縛る。
 */
export const ORCHESTRATOR_ORIGINS = ['typed', 'voice-held', 'voice-called', 'voice-toggle-first', 'voice-window', 'voice-toggle-rest'] as const;
export type OrchestratorOrigin = (typeof ORCHESTRATOR_ORIGINS)[number];

export const isOrchestratorOrigin = (v: unknown): v is OrchestratorOrigin => typeof v === 'string' && (ORCHESTRATOR_ORIGINS as readonly string[]).includes(v);

/** 強い声の印。言語によらず同じにする（見分けに使う）。 */
export const VOICE_MARK = '[voice]';
/** 弱い声の印。 */
export const VOICE_WINDOW_MARK = '[voice:window]';

const WEAK_ORIGINS: readonly OrchestratorOrigin[] = ['voice-window', 'voice-toggle-rest'];
/** 本文の頭の、出来事と声の印（大小を問わず、`[voice:…]` の変種も含む）。 */
const LEADING_MARK = /^\s*\[(?:hangar|voice)(?::[^\]]*)?\]/i;

/**
 * 由来から印を付けた本文を返す。付ける前に、本文の頭にある `[hangar]` と `[voice…]` の印を全部剥がす。
 * 端末が出来事や強い声を名乗れないようにするためである。剥がして空になれば空を返す。
 */
export function markOrchestratorText(text: string, origin: OrchestratorOrigin): string {
  let body = text;
  for (let m = LEADING_MARK.exec(body); m; m = LEADING_MARK.exec(body)) body = body.slice(m[0].length);
  body = body.trim();
  if (body === '' || origin === 'typed') return body;
  return `${WEAK_ORIGINS.includes(origin) ? VOICE_WINDOW_MARK : VOICE_MARK} ${body}`;
}

/** 手で書き換えた値と古い設定を、既定に寄せて読む。 */
export function orchestratorOf(raw: unknown): OrchestratorSetting {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_ORCHESTRATOR.enabled,
    sessionId: typeof o.sessionId === 'string' && o.sessionId !== '' ? o.sessionId : null,
    model: isModelName(o.model) ? o.model : DEFAULT_ORCHESTRATOR.model,
    effort: isEffort(o.effort) ? o.effort : DEFAULT_ORCHESTRATOR.effort,
  };
}

/** 設定の API が受ける変更。入り切り、モデル、effort だけで、会話の id は受けない。 */
export function isOrchestratorPatch(v: unknown): v is Partial<Pick<OrchestratorSetting, 'enabled' | 'model' | 'effort'>> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0 || keys.some((k) => k !== 'enabled' && k !== 'model' && k !== 'effort')) return false;
  if ('enabled' in o && typeof o.enabled !== 'boolean') return false;
  if ('model' in o && !isModelName(o.model)) return false;
  if ('effort' in o && !isEffort(o.effort)) return false;
  return true;
}
