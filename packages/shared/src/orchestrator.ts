import { isEffort } from './launchChoices.ts';
import { isModelName } from './summaryEngine.ts';

/**
 * 統括（全セッションを統括する常駐の会話、docs/design.md「統括」）の設定。この PC だけの設定で、同期しない。
 * enabled を入れた PC が宿主になる。sessionId は宿主が起こした会話の id で、見張り（OrchestratorKeeper）だけが書く。
 * model、effort、account は統括を起こすたびに渡す（account が null なら、その時のいまのアカウント）。既定は Sonnet と medium（用途ごとには分けない）。
 * history は前の統括の会話（系譜）で、古い順。見張りだけが書く（docs/design.md「統括」の系譜）。
 */
export type OrchestratorSetting = { enabled: boolean; sessionId: string | null; model: string; effort: string; account: string | null; history: OrchestratorHistoryEntry[] };

/**
 * 統括を新しい会話に切り替えた理由。
 * fresh は利用者が始め直した、auto は文脈が太った、agent は起動の設定でアプリが変わった、gone は会話が消えて起こし直した。
 */
export const ORCHESTRATOR_SWITCH_REASONS = ['fresh', 'auto', 'agent', 'gone'] as const;
export type OrchestratorSwitchReason = (typeof ORCHESTRATOR_SWITCH_REASONS)[number];

/** 系譜の 1 件。startedAt は分からなければ null。 */
export type OrchestratorHistoryEntry = { sessionId: string; startedAt: number | null; endedAt: number; reason: OrchestratorSwitchReason };

/** 系譜に残す件数。古いものから落とす（会話そのものは消さない）。 */
export const ORCHESTRATOR_HISTORY_MAX = 20;

export const DEFAULT_ORCHESTRATOR: OrchestratorSetting = { enabled: false, sessionId: null, model: 'sonnet', effort: 'medium', account: null, history: [] };

function historyEntryOf(v: unknown): OrchestratorHistoryEntry | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.sessionId !== 'string' || o.sessionId === '') return null;
  if (typeof o.endedAt !== 'number' || !Number.isFinite(o.endedAt)) return null;
  if (!(ORCHESTRATOR_SWITCH_REASONS as readonly unknown[]).includes(o.reason)) return null;
  const startedAt = typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : null;
  return { sessionId: o.sessionId, startedAt, endedAt: o.endedAt, reason: o.reason as OrchestratorSwitchReason };
}

/** 系譜の末尾に 1 件足し、上限を越えた古いものを落とす。 */
export function pushOrchestratorHistory(history: readonly OrchestratorHistoryEntry[], entry: OrchestratorHistoryEntry): OrchestratorHistoryEntry[] {
  return [...history, entry].slice(-ORCHESTRATOR_HISTORY_MAX);
}

/** 統括の系譜の id。今の会話を先頭に、過去の会話を古い順に、重なりなしで返す。 */
export function orchestratorLineage(o: Pick<OrchestratorSetting, 'sessionId' | 'history'>): string[] {
  const ids = [...(o.sessionId !== null ? [o.sessionId] : []), ...o.history.map((h) => h.sessionId)];
  return [...new Set(ids)];
}

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
    account: typeof o.account === 'string' && o.account !== '' ? o.account : null,
    history: Array.isArray(o.history) ? o.history.map(historyEntryOf).filter((h): h is OrchestratorHistoryEntry => h !== null).slice(-ORCHESTRATOR_HISTORY_MAX) : [],
  };
}

/** 設定の API が受ける変更。入り切り、モデル、effort、アカウント（空でない文字列か null）だけで、会話の id と系譜は受けない。 */
export function isOrchestratorPatch(v: unknown): v is Partial<Pick<OrchestratorSetting, 'enabled' | 'model' | 'effort' | 'account'>> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0 || keys.some((k) => k !== 'enabled' && k !== 'model' && k !== 'effort' && k !== 'account')) return false;
  if ('enabled' in o && typeof o.enabled !== 'boolean') return false;
  if ('model' in o && !isModelName(o.model)) return false;
  if ('effort' in o && !isEffort(o.effort)) return false;
  if ('account' in o && o.account !== null && (typeof o.account !== 'string' || o.account === '')) return false;
  return true;
}
