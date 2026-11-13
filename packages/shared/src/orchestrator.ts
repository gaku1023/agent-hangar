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
