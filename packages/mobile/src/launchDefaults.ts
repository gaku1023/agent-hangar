/**
 * 新しい会話のデフォルト（設定の「新しい会話のデフォルト」）と、新しい会話の画面と設定が共に使う選択肢の名前。
 *
 * 既定は、新しい会話の画面を開いたときに最初から選んでおく値で、このスマホの localStorage にだけ持つ。
 * PC とアカウントは ID で持ち、そのとき選べなければ新しい会話の画面が無視する（今の初期値に戻す）。
 * 権限、モデル、effort は shared の並びにある値だけを受け、知らない値はデフォルト（空）に戻す。
 * エージェントは opencode のときだけ持つ（欄が無ければ Claude Code）。opencode のモードとモデルは PC の一覧から選ぶので、既定には持たない。
 * 自動承認も既定に持たない（危ない値を毎回の初期値にしない。PC のダイアログと同じ）。
 */

import { AGENT_DISPLAY_NAME } from '@agent-hangar/shared/src/agents.ts';
import type { MobileAgent } from '@agent-hangar/shared/src/mobile.ts';
import { EFFORT_VALUES, MODEL_CHOICES, PERMISSION_MODE_VALUES } from '@agent-hangar/shared/src/launchChoices.ts';

/**
 * 権限モードの表示名。PC の新規セッションのダイアログ（packages/ui の permissionModel.ts と ja の launch.value.default）と同じ文。
 * スマホは packages/ui を読まないので写して持つ。並びと値は shared の PERMISSION_MODE_VALUES。
 */
export const PERMISSION_NAMES: Record<(typeof PERMISSION_MODE_VALUES)[number], string> = {
  '': 'デフォルト',
  plan: 'Plan',
  manual: 'Manual',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};
/** 空の値（デフォルト）の表示名。 */
export const DEFAULT_LABEL = 'デフォルト';
/** モデルの選択肢。先頭の空はデフォルト。 */
export const MODEL_OPTIONS: readonly string[] = ['', ...MODEL_CHOICES];
export const PERMISSION_OPTIONS: readonly string[] = PERMISSION_MODE_VALUES;
export const EFFORT_OPTIONS: readonly string[] = EFFORT_VALUES;

export const permissionName = (v: string): string => PERMISSION_NAMES[v as keyof typeof PERMISSION_NAMES] ?? v;

export type LaunchDefaults = {
  /** 既定の PC の ID。null は指定なし。 */
  pc: string | null;
  /** 既定のアカウントの ID。null は指定なし。 */
  account: string | null;
  permissionMode: string;
  model: string;
  effort: string;
  /** 既定のエージェント。opencode のときだけ持つ。opencode を選べない PC では新しい会話の画面が無視する。 */
  agent?: MobileAgent;
};

/** エージェントの表示名。 */
export const AGENT_NAMES = AGENT_DISPLAY_NAME;

export const EMPTY_DEFAULTS: LaunchDefaults = Object.freeze({ pc: null, account: null, permissionMode: '', model: '', effort: '' });

const KEY = 'hangar.mobile.launchDefaults';

const idOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const oneOf = (v: unknown, list: readonly string[]): string => (typeof v === 'string' && list.includes(v) ? v : '');

/** 既定を読む。無いとき、読めないとき、形が違うときは全部デフォルト。 */
export function loadLaunchDefaults(): LaunchDefaults {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_DEFAULTS };
    const v = JSON.parse(raw) as Partial<Record<keyof LaunchDefaults, unknown>> | null;
    if (!v || typeof v !== 'object') return { ...EMPTY_DEFAULTS };
    return {
      pc: idOf(v.pc),
      account: idOf(v.account),
      permissionMode: oneOf(v.permissionMode, PERMISSION_OPTIONS),
      model: oneOf(v.model, MODEL_OPTIONS),
      effort: oneOf(v.effort, EFFORT_OPTIONS),
      ...(v.agent === 'opencode' ? { agent: 'opencode' as const } : {}),
    };
  } catch {
    return { ...EMPTY_DEFAULTS };
  }
}

export function saveLaunchDefaults(d: LaunchDefaults): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ pc: d.pc, account: d.account, permissionMode: d.permissionMode, model: d.model, effort: d.effort, ...(d.agent === 'opencode' ? { agent: 'opencode' } : {}) }));
  } catch {
    // 置けなければ、次に開いたときデフォルトに戻るだけである。
  }
}

/** 既定を忘れる（このスマホの接続を外したとき）。 */
export function clearLaunchDefaults(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 消せなくても、次の接続で選び直せば上書きされる。
  }
}
