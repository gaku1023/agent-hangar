import { formatRoute, type SearchFilter, type SearchParamsDto } from '@agent-hangar/shared';
import { overlayReplaceable } from './overlay.ts';
import { agentTabStep, jumpStep, leaveTranscriptStep } from './sessionView.ts';
import type { Effect, Input, Overlay, SearchQuery, State, Step } from './types.ts';

/**
 * サーバに問い合わせるか。
 * キーワードがあるときと、触ったファイルで絞るときである。触ったファイルは手元のセッションに無い情報だからである。
 * それ以外の絞り込みは、手元のセッションで絞る。
 */
export function usesServerSearch(search: State['search']): boolean {
  return search.text !== '' || !!search.filter.file;
}

/**
 * 条件が 1 つでも効いているか。キーワード、状態のタブ、プロジェクト、期間、動き、触ったファイルのどれか。
 * 無ければ Sessions は節で読み、あれば平らな結果にする（★）。
 */
export function hasConditions(search: State['search']): boolean {
  return search.text !== '' || Object.values(search.filter).some((v) => v !== undefined);
}

/**
 * 期間の始まりの時刻。
 * days 日分は、今日の 0 時から数えて days - 1 日さかのぼった日の 0 時からである。
 * 1 なら今日の 0 時からで、「今日」の帯が暦の今日と一致する。
 */
export function periodStart(days: number, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

/** 日数で持った問い合わせを、送る時刻の since に直す。 */
export function toSearchParams(query: SearchQuery, now: number): SearchParamsDto {
  const { days, ...rest } = query;
  return days ? { ...rest, since: periodStart(days, now) } : rest;
}

export function searchParams(state: State): SearchQuery {
  const f = state.search.filter;
  const p: SearchQuery = { q: state.search.text };
  if (f.projectId) p.projectId = f.projectId;
  if (f.days) p.days = f.days;
  if (f.until !== undefined) p.until = f.until;
  if (f.live !== undefined) p.live = f.live;
  if (f.file) p.file = f.file;
  // 状態のタブ。「すべて」のまま条件を入れたときは Archived を除く（presenters/sessions.ts の手元の絞り込みと同じ）。
  // サーバに問い合わせるのはキーワードか触ったファイルがあるとき（usesServerSearch）なので、ここに来るときはいつも条件がある。
  if (f.status) p.status = f.status;
  else p.hideArchived = true;
  return p;
}

/**
 * 画面を移るときに消えてよいオーバーレイを閉じる。
 * パレットと、読むだけのダイアログ（キーの一覧、昇格の完了）は、画面から離れたら残さない。
 * 確認、未解決のプロジェクト、入力のあるダイアログは、決めるまで閉じない種類なのでここでは触らない。
 */
function closeTransient(state: State): Overlay {
  return overlayReplaceable(state.overlay) ? { kind: 'none' } : state.overlay;
}

/**
 * 裏の画面を移してよいか。
 * 確認や入力のあるダイアログを開いたまま裏の画面だけを移すと、何に答えているのかが分からなくなる（⌘I と同じ考え方）。
 * ⌘, の設定、⌘[ ⌘] の戻る進む、パレットの行、入力待ちのカードと通知は、どれもここで止める。
 * パレットと読むだけのダイアログは、閉じてから移る（closeTransient）。
 * ダイアログの中から意図して移るもの（保持期間の「ほかの期間…」、起動や引き取りの完了など）は、別の Intent か runtime の入力なのでここを通らない。
 */
export function canMoveBehind(state: State): boolean {
  return overlayReplaceable(state.overlay);
}

/** 入力待ちが無いときの知らせ。 */
export const NO_WAITING = '入力待ちのセッションはありません';

/**
 * 「次の入力待ちへ」。
 * どのセッションが入力待ちかはストアにあるので、いまいるセッションを添えてランタイムに決めさせる（waiting.resolved で返る）。
 * パレットから出したときも、パレットの上でキーを打ったときも、パレットは閉じる。
 */
export function nextWaitingStep(state: State): Step {
  const closed: State = state.overlay.kind === 'palette' ? { ...state, overlay: { kind: 'none' } } : state;
  const from = state.screen.name === 'session' ? state.screen.id : null;
  return { state: closed, effects: [{ kind: 'waiting.next', from }] };
}

/**
 * 全文検索を出す。
 * セッション一覧の画面の欄の Enter と、パレットの「全文検索」の行が同じこの経路を通る。
 * 検索したらフォーカスを結果の一覧へ移す。
 * 新しい語なら一覧の画面が作り直され、一覧が自分でフォーカスを取りにくる（SessionRows の autoFocus）。
 * 同じ語で検索し直したときは作り直されず、autoFocus は 1 度きりなので、ここで毎回頼む。
 * filter があれば（Sessions の欄の Enter）、欄を読んだ条件で絞り込みをまるごと入れ替える。欄が正だからである。
 * 語が同じでトークンだけ変えたときはハッシュが変わらず hash.changed が来ないので、問い合わせ直しはここで出す。
 */
export function searchQueryStep(state: State, text: string, filter?: SearchFilter): Step {
  if (!canMoveBehind(state)) return { state, effects: [] };
  const next = { ...state, overlay: closeTransient(state), search: { text, filter: filter ?? state.search.filter } };
  const effects: Effect[] = [];
  const sameHash = state.screen.name === 'sessions' && (state.screen.q ?? '') === text;
  if (filter && sameHash && usesServerSearch(next.search)) effects.push({ kind: 'api.search', params: searchParams(next) });
  effects.push({ kind: 'navigate', route: text ? { name: 'sessions', q: text } : { name: 'sessions' } }, { kind: 'focus', target: 'results' });
  return { state: next, effects };
}

/** screen 領域：どの画面にいるか。URL のハッシュが正で、Intent は navigate 効果を出すだけ。 */
export function screenStep(state: State, input: Input): Step | null {
  // 行き先が決まったら、ターミナルで答える経路（session.open の focus: terminal）で開く。
  if (input.kind === 'runtime' && input.event.type === 'waiting.resolved') {
    const id = input.event.sessionId;
    if (!id) return { state, effects: [{ kind: 'toast', level: 'info', message: NO_WAITING }] };
    return screenStep(state, { kind: 'intent', intent: { type: 'session.open', id, focus: 'terminal' } });
  }
  if (input.kind === 'runtime' && input.event.type === 'hash.changed') {
    const route = input.event.route;
    // ブラウザの戻る・進む（マウスの戻るボタンなど）は Intent を通らず、ここへ直に届く。何段動いたかが moved に添えてある。
    const moved = input.event.moved;
    if (moved !== undefined) {
      const here = state.screen.name === 'booting' ? null : state.screen;
      // いまの画面と同じ URL に着いた（ダイアログの裏で戻し直した後など）。読み込み直さない。
      if (here && formatRoute(here) === formatRoute(route)) return { state, effects: [] };
      // 確認や入力のあるダイアログの裏では移さず、同じ段だけ履歴を戻して URL をいまの画面に合わせる（nav.back と同じ規則）。
      // 段が分からない（URL を手で書き換えた）ときは、いまの画面の URL を入れ直す。
      if (!canMoveBehind(state)) return { state, effects: moved !== 0 ? [{ kind: 'history.go', delta: -moved }] : here ? [{ kind: 'navigate', route: here }] : [] };
    }
    const effects: Effect[] = [];
    let next: State = { ...state, screen: route, overlay: closeTransient(state), focusOnOpen: null };
    // 見ていないセッションの接続は残さない。
    // xterm とバッファは残るので、戻れば tmux attach が現在の画面を描き直す。
    const left = state.screen.name === 'session' ? state.screen.id : null;
    if (left && !(route.name === 'session' && route.id === left)) {
      effects.push({ kind: 'terminal.disconnectSession', sessionId: left });
      // 検索の結果からの跳び先は、その画面にいる間だけのものである。戻ってきたときに跳び直さない。
      next = jumpStep(next, left, null);
      // 目次から跳ばした Claude は、離れる前に transcript から抜けさせる。
      // 戻ったときに古いターンのまま止まって見えないように。
      const leave = leaveTranscriptStep(next, left);
      if (leave) { next = leave.state; effects.push(...leave.effects); }
    }
    if (route.name === 'session') {
      // 検索の結果から開いたときは、最新の側ではなく跳び先の周りを読む。
      const jump = next.sessionView[route.id]?.jump;
      effects.push(jump ? { kind: 'api.loadEvents', sessionId: route.id, fromSeq: 0, aroundSeq: jump.seq } : { kind: 'api.loadEvents', sessionId: route.id, fromSeq: 0 }, { kind: 'terminal.connect', sessionId: route.id, tabId: null });
    }
    // 「ターミナルで答える」で開いた画面なら、つないだ端末にそのままフォーカスする。
    if (route.name === 'session' && state.focusOnOpen === route.id) effects.push({ kind: 'focus', target: 'terminal' });
    if (route.name === 'project') effects.push({ kind: 'api.loadMemo', projectId: route.id });
    if (route.name === 'settings') effects.push({ kind: 'api.loadSettingsExtras' });
    // 設定の画面を離れたら、欄の下の理由（保存の失敗）を消す。
    // 欄の値は戻ってくると保存済みの値に戻るので、理由だけが残ると、いまの値が断られたように読める。
    // 保存済みの印は番号を続けたいので残す。
    if (state.screen.name === 'settings' && route.name !== 'settings') {
      const kept = Object.fromEntries(Object.entries(next.settingsSave).filter(([, m]) => m.kind !== 'error'));
      if (Object.keys(kept).length !== Object.keys(next.settingsSave).length) next = { ...next, settingsSave: kept };
    }
    if (route.name === 'sessions') {
      const text = route.q ?? '';
      next = { ...next, search: { ...state.search, text } };
      if (usesServerSearch(next.search)) effects.push({ kind: 'api.search', params: searchParams(next) });
    }
    return { state: next, effects };
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    // 画面を移す Intent は、確認や入力のあるダイアログの裏では何もしない（canMoveBehind）。
    case 'nav.go': return canMoveBehind(state) ? { state: { ...state, overlay: closeTransient(state) }, effects: [{ kind: 'navigate', route: i.to }] } : { state, effects: [] };
    // 行き先はブラウザの履歴が決めるので、ここでは動かす向きだけを出す。戻った先は hash.changed で入ってくる。
    // 着いた先の hash.changed がパレットや読むだけのダイアログを閉じる。
    case 'nav.back': return canMoveBehind(state) ? { state, effects: [{ kind: 'history.go', delta: -1 }] } : { state, effects: [] };
    case 'nav.forward': return canMoveBehind(state) ? { state, effects: [{ kind: 'history.go', delta: 1 }] } : { state, effects: [] };
    case 'project.open': return canMoveBehind(state) ? { state: { ...state, overlay: closeTransient(state) }, effects: [{ kind: 'navigate', route: { name: 'project', id: i.id } }] } : { state, effects: [] };
    case 'session.open': {
      // 入力待ちのカードと通知は、ダイアログの上や窓の外から届く。
      // 通知のときは、殻が窓を前に出すので、ダイアログが前に出るだけになる。
      if (!canMoveBehind(state)) return { state, effects: [] };
      // 検索の結果から開いたときだけ跳び先を持つ。ほかの開き方では、前の跳び先を忘れる。
      state = jumpStep(state, i.id, i.seq !== undefined ? { seq: i.seq, query: i.q ?? '' } : null);
      const overlay = closeTransient(state);
      if (i.focus !== 'terminal') return { state: { ...state, overlay, focusOnOpen: null }, effects: [{ kind: 'navigate', route: { name: 'session', id: i.id } }] };
      // 答える先は Claude のタブなので、シェルのタブを選んでいたら戻す。
      // もうその画面にいればハッシュは変わらないので、戻した Claude のタブをつないでからフォーカスだけを出す。
      if (state.screen.name === 'session' && state.screen.id === i.id) {
        const back = agentTabStep(state, i.id);
        const connect: Effect[] = back ? [...back.effects, { kind: 'terminal.connect', sessionId: i.id, tabId: null }] : [];
        return { state: { ...(back?.state ?? state), overlay }, effects: [...connect, { kind: 'focus', target: 'terminal' }] };
      }
      const back = agentTabStep(state, i.id) ?? { state, effects: [] };
      return { state: { ...back.state, overlay, focusOnOpen: i.id }, effects: [...back.effects, { kind: 'navigate', route: { name: 'session', id: i.id } }] };
    }
    case 'session.nextWaiting': return nextWaitingStep(state);
    case 'search.query': return searchQueryStep(state, i.text, i.filter);
    case 'search.filter': {
      const next = { ...state, search: { ...state.search, filter: { ...state.search.filter, ...i.patch } } };
      const effects: Effect[] = state.screen.name === 'sessions' && usesServerSearch(next.search) ? [{ kind: 'api.search', params: searchParams(next) }] : [];
      return { state: next, effects };
    }
    // 語と絞り込みをまとめて外す。語は URL にも乗っているので、語の無い一覧の URL へ移る。
    // 着いた先（hash.changed）では語も触ったファイルも無いので、問い合わせずに手元の全件を組む。
    case 'search.clear': return !canMoveBehind(state) ? { state, effects: [] } : { state: { ...state, search: { text: '', filter: {} } }, effects: [{ kind: 'navigate', route: { name: 'sessions' } }] };
    case 'search.more': {
      const effects: Effect[] = state.screen.name === 'sessions' && usesServerSearch(state.search) ? [{ kind: 'api.search', params: { ...searchParams(state), offset: i.offset } }] : [];
      return { state, effects };
    }
    default: return null;
  }
}
