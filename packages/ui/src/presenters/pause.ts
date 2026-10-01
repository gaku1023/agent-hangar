import { addDays, localDate } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

/** 戻る日の札（B1）。pick（日付を選ぶ…）だけは日を持たず、選んだときに暦の欄を出す。 */
export type PauseChoice = { key: 'today' | 'tomorrow' | 'monday' | 'nextWeek' | 'pick'; label: string; returnOn: string | null };
/**
 * Paused の入力。draft は理由の欄の下書き、candidateNote は提案から開いたときの Claude の根拠（変えたかを見るのに使う）。
 * today は暦の欄の下限で、initialReturnOn は開いたときに選んでおく日である。
 */
export type PauseProps = { sessionId: string; sessionName: string; from: 'menu' | 'candidate'; draft: string; candidateNote: string | null; initialReturnOn: string; today: string; choices: PauseChoice[] };

/**
 * 戻る日の札を今の手元の暦から作る。
 * 戻る日は日付だけで持つので、「今日の夕方」は今日、「明日」は明日として扱う。
 * 月曜は次の月曜で、今日が月曜なら 7 日後にする。来週は 7 日後である。
 */
export function pauseChoices(now: number): PauseChoice[] {
  const today = localDate(now);
  const toMonday = ((8 - new Date(now).getDay()) % 7) || 7;
  return [
    { key: 'today', label: '今日の夕方', returnOn: today },
    { key: 'tomorrow', label: '明日', returnOn: addDays(today, 1) },
    { key: 'monday', label: '月曜', returnOn: addDays(today, toMonday) },
    { key: 'nextWeek', label: '来週', returnOn: addDays(today, 7) },
    { key: 'pick', label: '日付を選ぶ…', returnOn: null },
  ];
}

/**
 * Paused の入力。overlay が pause のときだけ props を作る。
 * 提案から開いたときは根拠を下書きに入れ、提案の日を選んでおく。「⋯」から開いたときは、Paused なら今の理由と日を、ほかは空と明日を入れておく。
 */
export function presentPause(state: State, store: Store, now: number): PauseProps | null {
  if (state.overlay.kind !== 'pause') return null;
  const { sessionId, from } = state.overlay;
  const s = store.sessions[sessionId];
  if (!s) return null;
  const st = s.state ?? null;
  const cand = from === 'candidate' ? st?.candidate ?? null : null;
  const own = st?.status === 'paused' ? st : null;
  const choices = pauseChoices(now);
  return {
    sessionId, sessionName: s.name ?? '（名前なし）', from,
    draft: cand ? cand.note ?? '' : own?.note ?? '',
    candidateNote: cand?.note ?? null,
    initialReturnOn: cand?.returnOn ?? own?.returnOn ?? choices[1]!.returnOn!,
    today: choices[0]!.returnOn!,
    choices,
  };
}
