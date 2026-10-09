import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useRuntime } from './hooks/useRuntime.ts';
import { IntentRoot } from './intent/chain.tsx';
import { canMoveBehind } from './mediator/screen.ts';
import { defaultSessionView } from './mediator/sessionView.ts';
import { presentConfirm } from './presenters/confirm.ts';
import { presentHome } from './presenters/home.ts';
import { storeLanguage } from './presenters/i18n.ts';
import { presentOnboarding } from './presenters/onboarding.ts';
import { presentNewProject } from './presenters/newProject.ts';
import { newSessionTarget, presentNewSession } from './presenters/newSession.ts';
import { presentPalette } from './presenters/palette.ts';
import { presentPause } from './presenters/pause.ts';
import { presentProject } from './presenters/project.ts';
import { presentProjects } from './presenters/projects.ts';
import { presentPromote, presentPromoted } from './presenters/promote.ts';
import { presentRetentionDialog } from './presenters/retentionDialog.ts';
import { presentSession } from './presenters/session.ts';
import { presentSessions } from './presenters/sessions.ts';
import { presentSettings } from './presenters/settings.ts';
import { presentShell } from './presenters/shell.ts';
import { presentToasts } from './presenters/toasts.ts';
import { createApi, type ApiClient } from './runtime/api.ts';
import type { Runtime } from './runtime/runtime.ts';
import type { TerminalHost } from './runtime/terminals.ts';
import { matchKey } from './keys.ts';
import { createSwipeDetector, SWIPE_IDLE_MS, SWIPE_STALE_HIDE_MS } from './swipe.ts';
import { currentRunOf, tabsOf } from './store/store.ts';
import { CommandPalette } from './views/CommandPalette.tsx';
import { ConfigPreviewDialog } from './views/ConfigPreviewDialog.tsx';
import { RetentionDialog } from './views/RetentionDialog.tsx';
import { ConfirmDialog } from './views/ConfirmDialog.tsx';
import { HomeScreen } from './views/HomeScreen.tsx';
import { NewProjectDialog } from './views/NewProjectDialog.tsx';
import { NewSessionDialog } from './views/NewSessionDialog.tsx';
import { PauseDialog } from './views/PauseDialog.tsx';
import { ProjectScreen } from './views/ProjectScreen.tsx';
import { ProjectsScreen } from './views/ProjectsScreen.tsx';
import { PromoteDialog, PromotedDialog } from './views/PromoteDialog.tsx';
import { ResolveProjectDialog } from './views/ResolveProjectDialog.tsx';
import { SessionScreen } from './views/SessionScreen.tsx';
import { SessionsScreen } from './views/SessionsScreen.tsx';
import { SettingsScreen } from './views/SettingsScreen.tsx';
import { ShortcutsDialog } from './views/ShortcutsDialog.tsx';
import { Shell } from './views/Shell.tsx';
import { SwipeHint } from './views/SwipeHint.tsx';
import { blocksSwipe } from './views/swipeTarget.ts';
import { motionMs } from './views/primitives/motion.ts';
import { TerminalHostContext } from './views/TerminalPane.tsx';
import { CopiedContext } from './views/primitives/CommandLine.tsx';
import { LanguageRoot } from './views/primitives/language.tsx';
import { PromptAssistContext, type PromptAssist } from './views/primitives/promptAssist.ts';
import { ToastStack } from './views/ToastStack.tsx';

/**
 * 指の位相の受け口。
 * デスクトップの殻（Rust）が、NSEvent の位相から「指が離れた」を `__hangarSwipeEnd` で叩き、
 * 位相を読める環境であることを `__hangarPhaseAware` で知らせてくる。
 */
type PhaseWindow = Window & { __hangarPhaseAware?: boolean; __hangarSwipeBegin?: () => void; __hangarSwipeEnd?: () => void };
const phaseWindow = (): PhaseWindow => window as PhaseWindow;
const phaseAware = (): boolean => phaseWindow().__hangarPhaseAware === true;

/** 相対時刻のために現在時刻を一定間隔で更新する。 */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

/** TerminalHost の状態が変わるたびに再描画する。接続の状態は React の外にあるからである。 */
function useTerminalHost(host: TerminalHost): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => host.subscribe(force), [host]);
}

export function Root(props: { runtime: Runtime; api?: ApiClient; terminals: TerminalHost }) {
  const rt = props.runtime;
  const { state, store } = useRuntime(rt);
  // 切れているあいだは「あと何秒で再接続するか」を出すので、30 秒刻みでは数字が嘘になる。そのあいだだけ秒で刻む。
  const now = useNow(state.connection === 'disconnected' ? 1000 : 30_000);
  useTerminalHost(props.terminals);
  const [projectFilter, setProjectFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  // スワイプの矢印。React を通さずに触るので、節点だけ持つ。
  const swipeHintRef = useRef<HTMLDivElement>(null);

  // トーストの時間切れは、トーストごとに ToastStack が持つ（info だけが時間で消える）。

  // 未解決ダイアログの候補は Root が API を直接引く。
  // Presenter に通す値ではなく、ダイアログの中だけで使う一時データだからである。
  const overlay = state.overlay;
  const unresolvedId = overlay.kind === 'resolveProject' ? overlay.projectId : null;
  const queryCandidates = (name: string) => { if (unresolvedId) (props.api ?? apiFromRuntime(rt)).candidates(unresolvedId, name).then(setCandidates).catch(() => setCandidates([])); };
  useEffect(() => { if (unresolvedId) queryCandidates(store.projects[unresolvedId]?.name ?? ''); else setCandidates([]); }, [unresolvedId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 初期プロンプト欄がサーバに頼むこと。画面は fetch を呼ばないので、ここで api をつなぐ。
  // 知らせは、ほかの失敗と同じく server の toast の入力として流す（runtime 内の toast と同じ経路）。
  const promptAssist = useMemo<PromptAssist>(() => {
    const api = props.api ?? apiFromRuntime(rt);
    return {
      commands: (projectId) => api.promptCommands(projectId),
      files: (projectId, query) => api.promptFiles(projectId, query),
      upload: (file) => api.uploadDrop(file, file.name),
      existing: (paths) => api.existingDrops(paths),
      notify: (message) => rt.dispatch({ kind: 'server', event: { type: 'toast', level: 'error', message } }),
    };
  }, [props.api, rt]);

  // パレットの入力の文字は Root が持つ。
  // ダイアログの外へ出ない一時の値なので、Mediator には入れない。
  const overlayKind = overlay.kind;
  const paletteOpen = overlayKind === 'palette';
  const [paletteQuery, setPaletteQuery] = useState('');
  useEffect(() => { if (!paletteOpen) setPaletteQuery(''); }, [paletteOpen]);

  // ショートカットの対象になる、いま見ているセッションのタブ。
  const sessionId = state.screen.name === 'session' ? state.screen.id : null;
  const shortcutRun = sessionId ? currentRunOf(store, sessionId) : null;
  const shortcutTabs = shortcutRun ? tabsOf(store, shortcutRun.id) : [];
  const shortcutView = sessionId ? state.sessionView[sessionId] ?? defaultSessionView() : null;
  const selectedTabId = shortcutView?.selectedTab ?? shortcutTabs[0]?.id ?? null;
  // TabStrip の分割ボタンと同じ条件で、タブが 2 つ無いときは ⌘\ を出さない。
  const canSplit = shortcutTabs.length >= 2;
  // 終わったセッションの本文が画面に出ているか。ターミナルが出ていれば本文は無い（SessionScreen と同じく currentRunOf で決まる）。
  const transcriptShown = !!sessionId && !shortcutRun && store.sessions[sessionId]?.hasTranscript === true;
  // 最後にフォーカスのあったターミナルの枠のタブ。⌘W はこの枠のタブを閉じる。
  // 分割中は左右のどちらにもフォーカスが来るので、選択中のタブ（左）では足りない。
  // フォーカスは DOM の事実で、描き方も変えないので、Mediator へは入れずに Root が覚える。
  const focusedPane = useRef<string | null>(null);
  useEffect(() => {
    const remember = (e: Event) => {
      const tab = paneTabOf(e.target);
      if (tab) focusedPane.current = tab;
    };
    // 枠の中の xterm にフォーカスが入ったときと、枠を押したときの両方で覚える。
    // 案内の帯のように、押してもフォーカスの入らない所があるからである。
    document.addEventListener('focusin', remember);
    document.addEventListener('pointerdown', remember);
    return () => { document.removeEventListener('focusin', remember); document.removeEventListener('pointerdown', remember); };
  }, []);
  // ⌘N で開くダイアログの最初の選択。ヘッダーの新規ボタンと同じものを選ぶ。
  const { projectId: newProjectId, scratch: newScratch } = newSessionTarget(state, store);

  // キーボード。
  // 打鍵と操作の対応は keys.ts の表が持ち、ここは当たった操作を Intent に変えるだけにする。
  // 受け取らなかった打鍵は preventDefault せずに落とすので、⌘1 やセッション画面の外の ⌘W はそのままブラウザと OS のものになる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      // WKWebView は、入力欄の外の Backspace で履歴を 1 つ戻す。いまの Chrome と Safari には無い動きなので止める。
      // 入力欄とターミナル（xterm の textarea）では文字を消す打鍵なので、そのまま通す。
      if (e.key === 'Backspace') {
        if (!typing && !el?.isContentEditable) e.preventDefault();
        return;
      }
      // ターミナルにフォーカスがあるときは、⌘ を含む組み合わせだけを hangar が処理する。
      // Ctrl の打鍵は端末のものなので、preventDefault せずに xterm へ渡す。
      const inTerminal = !!el?.closest?.('.term-host');
      if (inTerminal && !e.metaKey) return;
      const id = matchKey(e);
      if (!id) return;
      // 何も開いていないときの入力欄の Esc は、その欄を離れる打鍵にする。ヘッダーの検索欄から抜ける手がほかに無いからである。
      // ダイアログやパレットの入力欄では、そのダイアログが自分で Esc を処理して閉じるので、ここでは触らない。
      // 部品が先に Esc を処理した（既定を止めた）ときも重ねない。ターミナルの Esc は上で xterm へ渡している。
      // 日本語の変換中の Esc は変換を取り消す打鍵なので、欄に残す。
      const composing = e.isComposing || e.keyCode === 229;
      if (id === 'overlay.close' && overlayKind === 'none' && (typing || el?.isContentEditable) && !e.defaultPrevented && !composing) {
        e.preventDefault();
        el?.blur();
        return;
      }
      // 修飾の無い打鍵は入力欄では文字なので、横取りしない。
      if (!e.metaKey && !e.ctrlKey && typing) return;
      const take = () => e.preventDefault();
      switch (id) {
        case 'tab.select': {
          const t = shortcutTabs[Number(e.key) - 1];
          if (t) { take(); rt.emit({ type: 'tab.select', tabId: t.id }); }
          return;
        }
        case 'tab.close': {
          // セッション画面では、閉じるものが無くても窓（アプリ）を閉じさせない。
          // 押し違いでアプリごと落ちると、同梱サーバまで止まるからである。
          if (!sessionId) return;
          take();
          // ダイアログやパレットを開いている間は、裏のタブを閉じない（⌘I と同じ扱い）。
          if (overlayKind !== 'none') return;
          // 対象は、打鍵を受けた枠か、最後にフォーカスのあった枠のタブにする。
          // 覚えた枠がもう出ていなければ（別のタブや別のセッションに移った後）、選択中のタブに戻す。
          const remembered = focusedPane.current && document.querySelector(`.term-host[data-tab="${CSS.escape(focusedPane.current)}"]`) ? focusedPane.current : null;
          const target = paneTabOf(el) ?? remembered ?? selectedTabId;
          const t = shortcutTabs.find((x) => x.id === target);
          // Claude のタブは閉じない。止めるのは「停止」の役目である。
          if (t && t.kind === 'shell') rt.emit({ type: 'tab.close', tabId: t.id });
          return;
        }
        case 'split.toggle': if (canSplit) { take(); rt.emit({ type: 'split.toggle' }); } return;
        case 'transcript.toggle': take(); rt.emit({ type: 'transcript.toggle' }); return;
        // 本文の中の検索。本文が出ているときだけ受け、ターミナルが出ているときはターミナルとブラウザに渡す。
        case 'transcript.find': if (transcriptShown && sessionId && overlayKind === 'none') { take(); rt.emit({ type: 'transcript.find', sessionId, open: true }); } return;
        // 端末が画面にあるときだけ受ける。セッション画面でも、終わったセッションの本文だけなら端末は無い。
        // 端末の無いときはブラウザの拡大に渡す。
        // 端末が出るかどうかは presentSession と同じく currentRunOf で決まる。
        case 'terminal.fontBigger': if (shortcutRun) { take(); props.terminals.zoom('in'); } return;
        case 'terminal.fontSmaller': if (shortcutRun) { take(); props.terminals.zoom('out'); } return;
        case 'terminal.fontReset': if (shortcutRun) { take(); props.terminals.zoom('reset'); } return;
        case 'palette.open': take(); rt.emit({ type: 'palette.open' }); return;
        case 'session.new': take(); rt.emit({ type: 'session.new.open', scratch: newScratch === true, ...(newProjectId ? { projectId: newProjectId } : {}) }); return;
        case 'session.newScratch': take(); rt.emit({ type: 'session.new.open', scratch: true }); return;
        // 次の入力待ちへ。ダイアログを開いている間は、その裏で画面を移さない。
        case 'session.nextWaiting': if (overlayKind === 'none' || overlayKind === 'palette') { take(); rt.emit({ type: 'session.nextWaiting' }); } return;
        case 'settings.open': take(); rt.emit({ type: 'nav.go', to: { name: 'settings' } }); return;
        // 入力欄の Ctrl+B はカーソルを 1 字戻す macOS の打鍵なので、⌘B だけを受け取る。
        case 'sidebar.toggle': if (typing && !e.metaKey) return; take(); rt.emit({ type: 'sidebar.toggle' }); return;
        case 'shortcuts.open': take(); rt.emit({ type: 'shortcuts.open' }); return;
        case 'nav.back': take(); rt.emit({ type: 'nav.back' }); return;
        case 'nav.forward': take(); rt.emit({ type: 'nav.forward' }); return;
        // Esc はオーバーレイを閉じる。
        // 未解決のプロジェクトだけは決めてもらうまで閉じない。
        // ダイアログの中にフォーカスがあるときは、ダイアログの殻（views/primitives/Dialog.tsx）が Esc を受けて既定を止めるので、二重に出さない。
        // 二重に閉じると、確認の後ろに控えた未解決のダイアログまで「あとで」で閉じてしまう。
        // ここが受けるのは、フォーカスが器の外（body など）にあるときの Esc だけである。
        case 'overlay.close':
          if (e.defaultPrevented || overlayKind === 'none' || overlayKind === 'resolveProject') return;
          rt.emit(overlayKind === 'palette' ? { type: 'palette.close' } : { type: 'overlay.close' });
          return;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rt, overlayKind, sessionId, shortcutRun, shortcutTabs, selectedTabId, canSplit, newProjectId, newScratch, props.terminals, transcriptShown]);

  // 確認や入力のあるダイアログの裏では、スワイプで画面を移さない（Mediator の canMoveBehind と同じ規則）。
  // Mediator も nav.back を捨てるが、それだけだと矢印が出て「動いた」と見えてしまうので、手勢そのものを受けない。
  // スワイプの効果は rt だけで組み直さないので、いまの値は ref で読む。
  const swipeBlocked = useRef(false);
  swipeBlocked.current = !canMoveBehind(state);

  // トラックパッドの横スワイプ。
  // ネイティブの手勢はスナップショットを滑らせる演出まで付いてくるので使わず、横方向のホイールを自分で積む。
  useEffect(() => {
    const swipe = createSwipeDetector();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 矢印は DOM を直に触って動かす。毎打鍵で React を回すと、画面ごと 60 回／秒で描き直すことになる。
    const hide = () => {
      const n = swipeHintRef.current;
      if (!n) return;
      delete n.dataset.dir;
      delete n.dataset.armed;
      delete n.dataset.done;
      n.style.setProperty('--swipe-ratio', '0');
    };
    const show = (dir: 'back' | 'forward', ratio: number, armed: boolean, done: boolean) => {
      const n = swipeHintRef.current;
      if (!n) return;
      n.dataset.dir = dir;
      if (armed) n.dataset.armed = 'true'; else delete n.dataset.armed;
      if (done) n.dataset.done = 'true'; else delete n.dataset.done;
      n.style.setProperty('--swipe-ratio', String(ratio));
    };
    // この手勢の持ち主。手勢ごとに一度だけ決める。
    // 打鍵ごとに決め直すと、箱が引かれて scrollLeft が変わるたびに持ち主が裏返り、矢印が荒ぶる。
    let owner: 'none' | 'box' | 'page' = 'none';
    let lastAt = -Infinity;
    // 指が離れた後も惰性の打鍵は流れ続ける。それは終わった手勢の残りなので、次の手勢が始まるまで捨てる。
    let ended = false;
    const onRelease = () => {
      owner = 'none';
      ended = true;
      const released = swipe.release();
      if (released) navigate(released); else hide();
    };
    const navigate = (r: 'back' | 'forward') => {
      clearTimeout(timer);
      // 戻る先が無いときは動かない。アプリの最初の頁の手前は、デスクトップではサーバの起動を待つ頁である。
      if ((r === 'back' && !rt.canGoBack()) || swipeBlocked.current) { hide(); return; }
      rt.emit({ type: r === 'back' ? 'nav.back' : 'nav.forward' });
      show(r, 1, true, true);
      // data-done が付くと --dur-exit で薄れて消える。片付けは display: none にするので、薄れ切ってから片付ける。
      // 少しの余りは、タイマーが遷移の最後のコマより先に走り、消え際が一瞬で切れて見えるのを防ぐためである。
      timer = setTimeout(hide, motionMs('--dur-exit') + 10);
    };
    const onWheel = (e: WheelEvent) => {
      // ブラウザには元から手勢がある。二重に持たず、標準の戻る進むに任せる。
      // この機能はデスクトップの殻の中だけのもので、指の位相が届くことが前提になっている。
      if (!phaseAware()) return;
      // 指が離れた後の惰性は、終わった手勢の残りである。次の手勢が始まるまで何もしない。
      if (ended) return;
      if (swipeBlocked.current) { swipe.begin(); clearTimeout(timer); hide(); return; }
      // 打鍵が久しく途切れていたら、そこからは新しい手勢である。
      if (e.timeStamp - lastAt > SWIPE_IDLE_MS) owner = 'none';
      lastAt = e.timeStamp;
      // 持ち主は手勢の最初の打鍵で決める。
      // 横へ流せる箱の中で、その向きにまだ余地があるなら、その手勢は最後まで箱のものにする。
      // 端に着いてからは、指を離して引き直せば画面のものになる。
      if (owner === 'none') owner = blocksSwipe(e.target, e.deltaX) ? 'box' : 'page';
      // 箱の手勢は最後まで箱のもの。持ち主は次の手勢の始まりで決め直す。
      if (owner === 'box') return;
      const r = swipe.feed({ deltaX: e.deltaX, deltaY: e.deltaY, at: e.timeStamp });
      if (r) { navigate(r); return; }
      const p = swipe.progress();
      clearTimeout(timer);
      if (p.dir === 0 || (p.dir < 0 && !rt.canGoBack())) { hide(); return; }
      show(p.dir < 0 ? 'back' : 'forward', p.ratio, p.armed, false);
      // 指が離れたことは、デスクトップでは OS の位相が教えてくれる（__hangarSwipeEnd）。
      // それが無いブラウザでは、打鍵が途切れたことを離した合図にする。
      // 位相が届く環境でも、位相を持たないマウスホイールのために長めの保険を置く。
      // 手勢の終わりは合図が決める。時間で画面を動かすことはしない。
      // 時間で打ち切る経路を残すと、合図が遅れた回に、指を置いたまま画面が動く。
      // ただし身構えていない手勢は、合図を取りこぼしても矢印が居残らないように、消すだけの保険を置く。
      if (!p.armed) timer = setTimeout(hide, SWIPE_STALE_HIDE_MS);
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    // 新しい手勢の始まり。前の手勢の名残をすべて捨てて、矢印も 0 に戻す。
    phaseWindow().__hangarSwipeBegin = () => {
      ended = false;
      owner = 'none';
      swipe.begin();
      clearTimeout(timer);
      hide();
    };
    phaseWindow().__hangarSwipeEnd = onRelease;
    return () => {
      clearTimeout(timer);
      window.removeEventListener('wheel', onWheel);
      delete phaseWindow().__hangarSwipeBegin;
      delete phaseWindow().__hangarSwipeEnd;
    };
  }, [rt]);

  const shell = presentShell(state, store, now);
  let body: ReactNode;
  if (!store.bootstrapped || state.screen.name === 'booting') body = <div className="empty boot-wait">読み込んでいます</div>;
  else switch (state.screen.name) {
    case 'home': body = <HomeScreen {...presentHome(state, store, now)} onboarding={presentOnboarding(store)} />; break;
    case 'projects': body = <ProjectsScreen {...presentProjects(state, store, now, projectFilter, showArchived)} filter={projectFilter} showArchived={showArchived} onFilter={setProjectFilter} onShowArchived={setShowArchived} />; break;
    case 'project': body = <ProjectScreen {...presentProject(state, store, now, state.screen.id)} />; break;
    case 'session': {
      const p = presentSession(state, store, now, state.screen.id);
      // ターミナルの接続の様子は、枠ごとに TerminalPane が Host から読む（分割で片方だけ切れることがある）。
      body = <SessionScreen {...p} />;
      break;
    }
    // 検索欄は defaultValue なので、外からの文言リセットで作り直せるように key を付ける。
    case 'sessions': body = <SessionsScreen key={state.search.text} {...presentSessions(state, store, now)} />; break;
    case 'settings': body = <SettingsScreen {...presentSettings(state, store, now)} />; break;
  }

  // 起動ダイアログはプロジェクトが変わったら作り直す。入力欄が非制御で、defaultValue を作り直しでしか変えられないからである。
  const newSession = presentNewSession(state, store, now);
  // Paused の入力は開くたびに作り直す（札と下書きの初期値を、開いたセッションと入口から取り直すため）。
  const pause = presentPause(state, store, now);
  const overlays = (
    <>
      {unresolvedId && <ResolveProjectDialog projectId={unresolvedId} name={store.projects[unresolvedId]?.name ?? unresolvedId} path={store.projects[unresolvedId]?.path ?? null} candidates={candidates} onQueryCandidates={queryCandidates} />}
      {newSession && <NewSessionDialog key={newSession.projectId ?? ''} {...newSession} />}
      {overlay.kind === 'palette' && <CommandPalette {...presentPalette(state, store, paletteQuery, now)!} onQuery={setPaletteQuery} />}
      {overlay.kind === 'newProject' && <NewProjectDialog {...presentNewProject(state, store)!} />}
      {overlay.kind === 'promote' && <PromoteDialog {...presentPromote(state, store)!} />}
      {overlay.kind === 'promoted' && <PromotedDialog {...presentPromoted(state, store)!} />}
      {overlay.kind === 'confirm' && <ConfirmDialog {...presentConfirm(state, store)!} />}
      {pause && <PauseDialog key={`${pause.sessionId}:${pause.from}`} {...pause} />}
      {/* 取り込みの下見は押したときだけ取りに来る一時の値なので、Presenter を通さず store から直に渡す。 */}
      {/* 未解決ダイアログの候補と同じ扱いである。 */}
      {overlay.kind === 'configPreview' && <ConfigPreviewDialog preview={store.configPreview} />}
      {overlay.kind === 'retention' && <RetentionDialog {...presentRetentionDialog(state, store, now)!} />}
      {overlay.kind === 'shortcuts' && <ShortcutsDialog />}
      <ToastStack {...presentToasts(state, store, now)} />
      <SwipeHint ref={swipeHintRef} />
    </>
  );

  return (
    <IntentRoot onIntent={rt.emit}>
      <TerminalHostContext.Provider value={props.terminals}>
        <CopiedContext.Provider value={state.copied}>
          <PromptAssistContext.Provider value={promptAssist}>
            <LanguageRoot language={storeLanguage(store)}>
              <Shell {...shell} overlays={overlays}>{body}</Shell>
            </LanguageRoot>
          </PromptAssistContext.Provider>
        </CopiedContext.Provider>
      </TerminalHostContext.Provider>
    </IntentRoot>
  );
}

/** 要素が居るターミナルの枠のタブ。枠の外なら null。 */
function paneTabOf(target: EventTarget | null): string | null {
  const el = target as HTMLElement | null;
  const pane = el?.closest?.('.term-pane');
  return pane?.querySelector<HTMLElement>('.term-host[data-tab]')?.dataset.tab ?? null;
}

const apiCache = new WeakMap<Runtime, ApiClient>();
function apiFromRuntime(rt: Runtime): ApiClient {
  let a = apiCache.get(rt);
  if (!a) { a = createApi(); apiCache.set(rt, a); }
  return a;
}
