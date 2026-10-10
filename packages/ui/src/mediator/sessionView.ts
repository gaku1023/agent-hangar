import { translatorOf } from '../presenters/i18n.ts';
import type { Effect, Input, SessionViewState, State, Step } from './types.ts';
import { aliveRunOf, currentRunOf, tabsOf, type Store } from '../store/store.ts';

export function defaultSessionView(): SessionViewState {
  return { agentId: null, showThinking: false, showRaw: false, follow: true, selectedTab: null, transcriptOpen: true, split: false, splitTab: null, openTurn: null, turnJump: null, jump: null };
}

/**
 * localStorage に残す形。follow だけは残さない。
 * 遡るために一度上へスクロールすると follow: false が焼き付き、次からそのセッションは最古の側で開いてしまう。
 * 追うかどうかはその場の操作で決まるものなので、開くたびに既定（真）から始める。
 * 目次で開いたターンと、そこへ跳ばした結果も同じくその場のものなので残さない。
 * 検索の結果から開いたときの跳び先も残さない。
 */
export function persistedSessionView(v: SessionViewState): Omit<SessionViewState, 'follow' | 'openTurn' | 'turnJump' | 'jump'> {
  const { follow: _drop, openTurn: _turn, turnJump: _jump, jump: _to, ...rest } = v;
  return rest;
}

/** 保存しない一時の状態（開いたターンと跳び先）だけを変える。保存する形は変わらないので、書き込みも出さない。 */
function local(state: State, id: string, p: Partial<SessionViewState>): Step {
  const cur = state.sessionView[id] ?? defaultSessionView();
  return { state: { ...state, sessionView: { ...state.sessionView, [id]: { ...cur, ...p } } }, effects: [] };
}

function patch(state: State, id: string, p: Partial<SessionViewState>): Step {
  const cur = state.sessionView[id] ?? defaultSessionView();
  const next = { ...cur, ...p };
  const effects: Effect[] = [{ kind: 'storage.save', key: `sv:${id}`, value: persistedSessionView(next) }];
  return { state: { ...state, sessionView: { ...state.sessionView, [id]: next } }, effects };
}

/**
 * 検索の結果から開くときの跳び先を覚える（jump が null なら忘れる）。
 * 跳ぶ間は末尾を追わない。追っていると窓が末尾に張り付き、跳び先が描かれない。
 * 同じ所をもう一度開いたときも跳び直すよう、開いた回数を進める。
 */
export function jumpStep(state: State, id: string, jump: { seq: number; query: string } | null): State {
  const cur = state.sessionView[id] ?? defaultSessionView();
  if (!jump) return cur.jump === null ? state : local(state, id, { jump: null }).state;
  return local(state, id, { jump: { ...jump, n: (cur.jump?.n ?? 0) + 1 }, follow: false }).state;
}

/**
 * セッション画面を開いたとき、動いていないセッションは末尾を追わず、先頭から開く。
 * 冒頭の 1 枚（要約、変更したファイル、ノートなど）はトランスクリプトの先頭にあるので、開いた直後に見えるようにするためである。
 * 動いているセッション（作業中、入力待ち、休み、生きた run があるもの）は、これまでどおり末尾を追う。
 * ストアがまだそのセッションを知らないときは、決めつけず何もしない。
 * 追うかどうかは保存しない状態なので、書き込みは出さない。「最新へ」（turn.latest）で追う形に戻せる。
 */
export function openAtLeadStep(state: State, store: Store, id: string): State {
  const s = store.sessions[id];
  if (!s || s.live !== null || aliveRunOf(store, id) !== null) return state;
  const cur = state.sessionView[id] ?? defaultSessionView();
  return cur.follow ? local(state, id, { follow: false }).state : state;
}

/**
 * 閉じたタブが左右どちらかの枠に居たら、その枠を空ける差分を返す。
 * 左右のどちらが閉じても相手だけでは分割が成立しないので、そのときは分割ごと畳む。
 * 片側だけ空けて split を真のまま残すと、次にタブが増えた瞬間に押していない分割が復活してしまう。
 * どちらの枠にも居なければ null を返す。
 */
function closedTabPatch(cur: SessionViewState, tabId: string): Partial<SessionViewState> | null {
  const p: Partial<SessionViewState> = {};
  if (cur.selectedTab === tabId) p.selectedTab = null;
  if (cur.splitTab === tabId || (cur.split && cur.selectedTab === tabId)) { p.split = false; p.splitTab = null; }
  return Object.keys(p).length ? p : null;
}

/**
 * そのセッションの左の枠を Claude のタブ（agent）に戻す。
 * 「ターミナルで答える」の問いは Claude のタブに出ているので、シェルのタブを選んだまま離れていても答える先はそこにする。
 * 分割中はどちらの枠に Claude のタブが居るかが run を見ないと分からず、左も Claude にすると同じ端末が左右に重なるので、分割ごと畳む。
 * 変えるものが無ければ null を返す。
 */
export function agentTabStep(state: State, id: string): Step | null {
  const cur = state.sessionView[id] ?? defaultSessionView();
  if (cur.selectedTab === null && !cur.split) return null;
  return patch(state, id, { selectedTab: null, split: false, splitTab: null });
}

/**
 * 目次から跳ばした Claude を transcript から抜けさせ、開いたターンを忘れる。
 * 跳ばしていなければ（turnJump が無ければ）何もせず null を返す。
 * 開いたターンと跳び先は保存しない状態なので、書き込みは出さない。
 * 画面を離れたときにも呼ぶ。
 * 抜けさせないと、戻ってきたとき Claude が古いターンを見せたまま止まって見える。
 */
export function leaveTranscriptStep(state: State, id: string): Step | null {
  const run = (state.sessionView[id] ?? defaultSessionView()).turnJump?.runId;
  if (!run) return null;
  const r = local(state, id, { openTurn: null, turnJump: null });
  return { state: r.state, effects: [{ kind: 'api.leaveTranscript', runId: run }] };
}

/**
 * 跳ばした run が当てはまれば、跳び先（turnJump）だけを忘れる。
 * 開いたターンは読めるので残す。
 * 保存しない状態なので書き込みは出さない。
 */
function forgetJump(state: State, id: string, match: (runId: string) => boolean): State {
  const tj = state.sessionView[id]?.turnJump;
  return tj && match(tj.runId) ? local(state, id, { turnJump: null }).state : state;
}

const currentSession = (state: State): string | null => (state.screen.name === 'session' ? state.screen.id : null);
const viewOf = (state: State, id: string) => state.sessionView[id] ?? defaultSessionView();

/** sessionView 領域：セッション画面の一時状態とターミナル接続の開閉。localStorage に保存し、同期しない。 */
export function sessionViewStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'server') {
    const ev = input.event;
    switch (ev.type) {
      case 'transcript.appended': {
        const open = currentSession(state) === ev.sessionId;
        // 追記は末尾に足すだけでよい。-1（過去へ遡る）を出すと、全件を読み終えるまで古い側が 500 件ずつ入ってしまう。
        return { state, effects: open ? [{ kind: 'api.loadEvents', sessionId: ev.sessionId, fromSeq: -2 }] : [] };
      }
      case 'run.started': {
        // 再開などで run が替わったら、前の run の跳び先は忘れる。
        const fresh = forgetJump(state, ev.run.sessionId, (runId) => runId !== ev.run.id);
        if (currentSession(fresh) !== ev.run.sessionId) return { state: fresh, effects: [] };
        const r = patch(fresh, ev.run.sessionId, { selectedTab: null });
        return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: ev.run.sessionId, tabId: ev.run.id }] };
      }
      case 'run.ended': {
        // 終わった run は transcript から抜けさせられない（サーバは 409 で断る）ので、跳び先ごと忘れる。
        const fresh = forgetJump(state, ev.run.sessionId, (runId) => runId === ev.run.id);
        return { state: fresh, effects: [{ kind: 'terminal.disconnect', tabId: ev.run.id }] };
      }
      case 'tab.upsert': {
        const t = ev.tab;
        if (t.closedAt !== null) {
          const off: Effect = { kind: 'terminal.disconnect', tabId: t.id };
          const cur = viewOf(state, t.sessionId);
          const p = closedTabPatch(cur, t.id);
          if (!p) return { state, effects: [off] };
          const r = patch(state, t.sessionId, p);
          // 繋ぎ直すのは、いま見ているセッションの左のタブが閉じたときだけ。
          const back: Effect[] = cur.selectedTab === t.id && currentSession(state) === t.sessionId ? [{ kind: 'terminal.connect', sessionId: t.sessionId, tabId: null }] : [];
          return { state: r.state, effects: [...r.effects, off, ...back] };
        }
        if (currentSession(state) !== t.sessionId || t.kind !== 'shell') return { state, effects: [] };
        const r = patch(state, t.sessionId, { selectedTab: t.id });
        return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: t.sessionId, tabId: t.id }, { kind: 'focus', target: 'terminal' }] };
      }
      default: return null;
    }
  }
  if (input.kind === 'runtime' && input.event.type === 'turnJump.done') {
    const e = input.event;
    // 別のターンを開いた後に届いた古い結果は捨てる。
    const cur = viewOf(state, e.sessionId).turnJump;
    if (cur?.seq !== e.seq) return { state, effects: [] };
    return patch(state, e.sessionId, { turnJump: { ...cur, status: e.status } });
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'transcript.showThinking': return patch(state, i.sessionId, { showThinking: i.show });
    case 'transcript.showRaw': return patch(state, i.sessionId, { showRaw: i.show });
    case 'transcript.follow': return patch(state, i.sessionId, { follow: i.follow });
    case 'transcript.loadMore': return { state, effects: [{ kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: -1 }] };
    case 'transcript.loadNewer': return { state, effects: [{ kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: -2 }] };
    case 'transcript.selectAgent': {
      const r = patch(state, i.sessionId, { agentId: i.agentId });
      return { state: r.state, effects: [...r.effects, { kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: 0 }] };
    }
    case 'turn.open': {
      // 開いているターンを閉じる。
      // 左の Claude をそこへ跳ばしていたら、transcript から抜けさせる。
      if (viewOf(state, i.sessionId).openTurn === i.seq) {
        const left = leaveTranscriptStep(state, i.sessionId);
        const r = patch(left?.state ?? state, i.sessionId, { openTurn: null, turnJump: null });
        return { state: r.state, effects: [...r.effects, ...(left?.effects ?? [])] };
      }
      // 跳び先を持たない（遠すぎて跳べない、または run が無い）ターンを開くとき。
      // 前に跳ばしていたら、左の Claude を古いターンの transcript に残さないよう、先に抜けさせる。
      if (!i.runId || !i.jump) {
        const left = leaveTranscriptStep(state, i.sessionId);
        const r = patch(left?.state ?? state, i.sessionId, { openTurn: i.seq, turnJump: null });
        return { state: r.state, effects: [...r.effects, ...(left?.effects ?? [])] };
      }
      // 跳ぶ先は Claude のタブなので、シェルのタブを出していたら戻して繋ぎ直す。
      const back = agentTabStep(state, i.sessionId);
      const connect: Effect[] = back ? [...back.effects, { kind: 'terminal.connect', sessionId: i.sessionId, tabId: null }] : [];
      const r = patch(back?.state ?? state, i.sessionId, { openTurn: i.seq, turnJump: { seq: i.seq, status: 'pending', runId: i.runId } });
      return { state: r.state, effects: [...connect, ...r.effects, { kind: 'api.jumpToPrompt', sessionId: i.sessionId, runId: i.runId, seq: i.seq, ...i.jump }] };
    }
    case 'turn.latest': {
      const r = patch(state, i.sessionId, { openTurn: null, turnJump: null, follow: true });
      return { state: r.state, effects: [...r.effects, ...(i.runId ? [{ kind: 'api.leaveTranscript', runId: i.runId } as Effect] : [])] };
    }
    case 'transcript.toggle': {
      const sid = currentSession(state);
      return sid ? patch(state, sid, { transcriptOpen: !viewOf(state, sid).transcriptOpen }) : { state, effects: [] };
    }
    case 'tab.open': {
      if (i.kind === 'shell') return { state, effects: [{ kind: 'api.openTab', sessionId: i.sessionId }] };
      const r = patch(state, i.sessionId, { selectedTab: null });
      return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: i.sessionId, tabId: null }] };
    }
    case 'tab.select': {
      const sid = currentSession(state);
      if (!sid) return { state, effects: [] };
      const cur = viewOf(state, sid);
      // 分割中に右のタブを選んだら左右を入れ替える。
      // そうでなければ左を差し替えるだけにする。
      const p: Partial<SessionViewState> = cur.split && cur.splitTab === i.tabId && cur.selectedTab ? { selectedTab: i.tabId, splitTab: cur.selectedTab } : { selectedTab: i.tabId };
      const r = patch(state, sid, p);
      return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: sid, tabId: i.tabId }, { kind: 'focus', target: 'terminal' }] };
    }
    case 'split.toggle': {
      const sid = currentSession(state);
      if (!sid) return { state, effects: [] };
      const view = viewOf(state, sid);
      if (view.split) return patch(state, sid, { split: false, splitTab: null });
      // 開くときに右へ置くタブは、ストアのタブの並びから決める。
      // 左は選択中のタブ、無ければ先頭。右はそれと違う最初のタブ。2 つ無ければ開かずに知らせる。
      const run = currentRunOf(store, sid);
      const tabs = run ? tabsOf(store, run.id) : [];
      const left = view.selectedTab ?? tabs[0]?.id ?? null;
      const right = tabs.find((t) => t.id !== left);
      if (!right) return { state, effects: [{ kind: 'toast', level: 'info', message: translatorOf(store)('mediator.sessionView.splitNeedsTwoTabs') }] };
      return patch(state, sid, { split: true, splitTab: right.id });
    }
    case 'tab.close': {
      const sid = currentSession(state);
      const close: Effect = { kind: 'api.closeTab', tabId: i.tabId };
      const p = sid ? closedTabPatch(viewOf(state, sid), i.tabId) : null;
      if (sid && p) { const r = patch(state, sid, p); return { state: r.state, effects: [...r.effects, close] }; }
      return { state, effects: [close] };
    }
    default: return null;
  }
}
