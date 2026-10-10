import type { Store } from '../store/store.ts';
import { launchStep } from './launch.ts';
import { resumeHereStep } from './resumeHere.ts';
import type { Input, MuxPending, State, Step } from './types.ts';

/**
 * psmux（tmux）が無いと分かっているか。
 * 準備の確かめが届く前は分からないので、止めない（サーバが断れば、いつもの失敗の知らせになる）。
 */
const muxMissing = (store: Store): boolean => store.readiness !== null && !store.readiness.tools.tmux.ok;

/**
 * 止める操作か。新しいセッション、再開、フォーク、この PC で再開、hangar に移動（adopt）、接続（attach）である。
 * adopt は外の claude を終わらせてから hangar の tmux で起こすので、無いまま進むと元の会話を止めたまま失敗する。確認の前でも後でも止める。
 * attach は Claude のバックグラウンドのサービスにつなぐが、つなぐ口（`claude attach`）は hangar の tmux のペインで起こすので、無ければ断られる。
 */
function pendingOf(a: Extract<Input, { kind: 'action' }>['action']): MuxPending | null {
  switch (a.type) {
    case 'session.new.submit': case 'session.resume': case 'session.fork': case 'session.resumeHere': case 'session.adopt': case 'session.attach': return a;
    default: return null;
  }
}

/** 止めていた操作を、受け持つ領域へそのまま渡す。 */
function forward(state: State, store: Store, pending: MuxPending): Step {
  const input: Input = { kind: 'action', action: pending };
  return (pending.type === 'session.resumeHere' ? resumeHereStep(state, input) : launchStep(state, store, input)) ?? { state, effects: [] };
}

/**
 * muxGuide 領域：psmux（Windows）と tmux が無いときの案内（段 6）。
 * セッションを始める操作を止めて案内のダイアログを出し（B2）、再確認（帯の B1、ダイアログ、設定の B3 の共通）を受け持つ。
 * 再確認の答えは Runtime が準備の確かめとして Store へ入れてから mux.checked で知らせるので、ここは進みの印だけを持つ。
 * 見つかったあとの「開始」は、止めていた操作を launch か resumeHere の領域へそのまま渡す。
 * 起動の操作を横取りするので、transition では launchStep と resumeHereStep より前に置く。
 */
export function muxGuideStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'runtime') {
    if (input.event.type !== 'mux.checked') return null;
    return { state: { ...state, muxCheck: input.event.found ? 'idle' : 'missing' }, effects: [] };
  }
  if (input.kind !== 'action') return null;
  const a = input.action;
  const o = state.overlay;
  if (a.type === 'mux.recheck') {
    if (state.muxCheck === 'checking') return { state, effects: [] };
    return { state: { ...state, muxCheck: 'checking' }, effects: [{ kind: 'api.recheckMux' }] };
  }
  if (a.type === 'mux.guide.proceed') {
    if (o.kind !== 'muxGuide' || muxMissing(store)) return { state, effects: [] };
    // 新しいセッションのダイアログから来たなら、そこへ戻してから送る。起動し終えたら launch の領域がダイアログと下書きを片付ける。
    return forward({ ...state, overlay: o.back ?? { kind: 'none' } }, store, o.pending);
  }
  if (a.type === 'overlay.close' && o.kind === 'muxGuide') return { state: { ...state, overlay: o.back ?? { kind: 'none' } }, effects: [] };
  const pending = pendingOf(a);
  if (pending === null || !muxMissing(store)) return null;
  // 送信中の重ね押しは、受け持つ領域の歯止めに任せる。
  if (state.launch.kind === 'submitting') return null;
  const back = o.kind === 'newSession' ? o : null;
  return { state: { ...state, overlay: { kind: 'muxGuide', pending, back } }, effects: [] };
}
