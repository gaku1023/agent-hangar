import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useRuntime } from './hooks/useRuntime.ts';
import { ActionRoot } from './action/chain.tsx';
import { canMoveBehind } from './mediator/screen.ts';
import { defaultSessionView } from './mediator/sessionView.ts';
import { presentConfigDialog } from './presenters/configSync.ts';
import { presentConfirm } from './presenters/confirm.ts';
import { presentHomeScreen } from './presenters/home.ts';
import { storeLanguage, translatorOf } from './presenters/i18n.ts';
import { presentNewProject } from './presenters/newProject.ts';
import { presentAddAccount } from './presenters/addAccount.ts';
import { presentProjectCandidates } from './presenters/projectCandidates.ts';
import { newSessionTarget, presentNewSession } from './presenters/newSession.ts';
import { presentPalette } from './presenters/palette.ts';
import { presentPause } from './presenters/pause.ts';
import { presentMoveSession } from './presenters/moveSession.ts';
import { presentResolveDialog } from './presenters/unresolved.ts';
import { presentMuxGuide } from './presenters/readiness.ts';
import { presentProject } from './presenters/project.ts';
import { presentProjects } from './presenters/projects.ts';
import { presentPromote, presentPromoted } from './presenters/promote.ts';
import { presentRetentionDialog } from './presenters/retentionDialog.ts';
import { presentDiffDialog } from './presenters/git.ts';
import { presentSession } from './presenters/session.ts';
import { presentSettings } from './presenters/settings.ts';
import { presentShell } from './presenters/shell.ts';
import { presentToasts } from './presenters/toasts.ts';
import { createApi, type ApiClient } from './runtime/api.ts';
import type { Runtime } from './runtime/runtime.ts';
import type { TerminalHost } from './runtime/terminals.ts';
import { clientPlatform, isMacClient, matchKey } from './keys.ts';
import { createLiftDetector, createSwipeDetector, swipeModeOf, SWIPE_IDLE_MS, SWIPE_RELEASE_GAP_MS, SWIPE_STALE_HIDE_MS } from './swipe.ts';
import { currentRunOf, tabsOf } from './store/store.ts';
import { CommandPalette } from './views/CommandPalette.tsx';
import { usePaletteFound } from './views/usePaletteFound.ts';
import { createFindStore, FindRoot } from './views/findStore.tsx';
import { ConfigSyncDialog } from './views/ConfigSyncDialog.tsx';
import { RetentionDialog } from './views/RetentionDialog.tsx';
import { ConfirmDialog } from './views/ConfirmDialog.tsx';
import { HomeScreen } from './views/HomeScreen.tsx';
import { NewProjectDialog } from './views/NewProjectDialog.tsx';
import { AddAccountDialog } from './views/AddAccountDialog.tsx';
import { ProjectCandidatesDialog } from './views/ProjectCandidatesDialog.tsx';
import { NewSessionDialog } from './views/NewSessionDialog.tsx';
import { PauseDialog } from './views/PauseDialog.tsx';
import { MoveSessionDialog } from './views/MoveSessionDialog.tsx';
import { MuxGuideDialog } from './views/MuxGuideDialog.tsx';
import { ProjectScreen } from './views/ProjectScreen.tsx';
import { ProjectsScreen } from './views/ProjectsScreen.tsx';
import { PromoteDialog, PromotedDialog } from './views/PromoteDialog.tsx';
import { ResolveProjectDialog } from './views/ResolveProjectDialog.tsx';
import { SessionScreen } from './views/SessionScreen.tsx';
import { PaneWorkspace } from './views/PaneWorkspace.tsx';
import { PaneDropOverlay } from './views/PaneDropOverlay.tsx';
import { presentPanes } from './presenters/panes.ts';
import { SettingsScreen } from './views/SettingsScreen.tsx';
import { ShortcutsDialog } from './views/ShortcutsDialog.tsx';
import { DiffDialog } from './views/DiffDialog.tsx';
import { Shell } from './views/Shell.tsx';
import { SwipeHint } from './views/SwipeHint.tsx';
import { blocksSwipe } from './views/swipeTarget.ts';
import { motionMs } from './views/primitives/motion.ts';
import { TerminalHostContext } from './views/TerminalPane.tsx';
import { CopiedContext } from './views/primitives/CommandLine.tsx';
import { LanguageRoot } from './views/primitives/language.tsx';
import { EditorNameRoot } from './views/primitives/editorName.tsx';
import { editorName, presentEditorMissing } from './presenters/editor.ts';
import { EditorMissing } from './views/EditorMissing.tsx';
import { PromptAssistContext, type PromptAssist } from './views/primitives/promptAssist.ts';
import { ToastStack } from './views/ToastStack.tsx';
import { useNow } from './views/primitives/useNow.ts';

/**
 * 指の位相の受け口。
 * macOS のデスクトップの殻（Rust）が、NSEvent の位相から「指が離れた」を `__hangarSwipeEnd` で叩き、
 * 位相を読める環境であることを `__hangarPhaseAware` で知らせてくる。
 * Windows の殻は位相を送らないので、離した瞬間の 0 の打鍵と、打鍵の途切れを離した合図にする（swipe.ts の swipeModeOf と createLiftDetector）。
 */
type PhaseWindow = Window & { __hangarPhaseAware?: boolean; __hangarSwipeBegin?: () => void; __hangarSwipeEnd?: () => void };
const phaseWindow = (): PhaseWindow => window as PhaseWindow;
const phaseAware = (): boolean => phaseWindow().__hangarPhaseAware === true;

/** TerminalHost の状態が変わるたびに再描画する。接続の状態は React の外にあるからである。 */
function useTerminalHost(host: TerminalHost): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => host.subscribe(force), [host]);
}

/** 画面全体を読み直す。試験は偽物を渡す。 */
const reloadPage = () => location.reload();

export function Root(props: { runtime: Runtime; api?: ApiClient; terminals: TerminalHost; reload?: () => void }) {
  const rt = props.runtime;
  const reload = props.reload ?? reloadPage;
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
  // 本文の中の検索（⌘F）の状態も Root が置き場を持つ。Mediator のほかの領域も Presenter も使わない、その場の操作である。
  // 本文の部品は画面を離れると外れるので、ここに置いて、戻ってきたときに同じ欄と語を出す。
  const [finds] = useState(createFindStore);
  useEffect(() => { if (!paletteOpen) setPaletteQuery(''); }, [paletteOpen]);
  // 最後の行に添える件数。ホームの欄と同じ検索を、少し待ってから 1 件だけ引いて数える。
  const paletteFound = usePaletteFound((params) => (props.api ?? apiFromRuntime(rt)).search(params), paletteQuery, paletteOpen);

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
  // 打鍵と操作の対応は keys.ts の表が持ち、ここは当たった操作を UiAction に変えるだけにする。
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
      // ターミナルにフォーカスがあるときは、macOS は ⌘ を含む組み合わせだけを、ほかは Ctrl+Shift+<キー>（と Ctrl+Alt+N）だけを hangar が処理する。
      // Ctrl だけの打鍵は端末のものなので、preventDefault せずに xterm へ渡す。どれを受けるかは keys.ts の matchKey が決める。
      // ターミナルの外では、macOS の外は ⌘ の役を Ctrl が担う。
      const mac = isMacClient();
      const inTerminal = !!el?.closest?.('.term-host');
      const id = matchKey(e, { mac, terminal: inTerminal });
      if (!id) return;
      // 再読み込みは、ターミナルと入力欄とダイアログのどこにフォーカスがあっても受ける（F5 は入力欄の文字でもない）。
      // macOS は ⌘R だけで、Ctrl+R は入力欄とターミナルのものとして渡す。
      // デスクトップの殻のメニューにも同じ ⌘R の項目があるが、頁が既定を止めるので二度は読み直さない。
      if (id === 'app.reload') {
        if (mac && !e.metaKey) return;
        e.preventDefault();
        reload();
        return;
      }
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
      // 入力欄の ⌘← と ⌘→（macOS の行頭と行末）、Ctrl+← と Ctrl+→（ほかの単語の移動）は、欄の打鍵なので戻ると進むに使わない（⌘[ と ⌘] は使う）。
      const editing = typing || !!el?.isContentEditable;
      if (editing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      // macOS の入力欄の Ctrl の打鍵は文字の編集（Ctrl+K で行末まで消す、Ctrl+B で 1 字戻るなど）なので、⌘ の付いたものだけを受け取る。
      // ほかの OS の入力欄の Ctrl+K や Ctrl+B には編集の役が無いので、受け取る。
      if (editing && mac && e.ctrlKey && !e.metaKey && !e.altKey) return;
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
        // セッション画面の宛先の 1 行をコピーする。ダイアログやパレットの裏では写さない。
        case 'session.copyAddress': if (sessionId && overlayKind === 'none') { take(); rt.emit({ type: 'session.copyAddress', id: sessionId }); } return;
        case 'session.copyId': if (sessionId && overlayKind === 'none') { take(); rt.emit({ type: 'session.copyId', id: sessionId }); } return;
        // 本文の中の検索。本文が出ているときだけ受け、ターミナルが出ているときはターミナルとブラウザに渡す。
        case 'transcript.find': if (transcriptShown && sessionId && overlayKind === 'none') { take(); finds.open(sessionId); } return;
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
        // macOS の入力欄の Ctrl+B（1 字戻る）は、上の入力欄の規則で渡している。
        case 'sidebar.toggle': take(); rt.emit({ type: 'sidebar.toggle' }); return;
        case 'shortcuts.open': take(); rt.emit({ type: 'shortcuts.open' }); return;
        case 'nav.back': take(); rt.emit({ type: 'nav.back' }); return;
        case 'nav.forward': take(); rt.emit({ type: 'nav.forward' }); return;
        // Esc はオーバーレイを閉じる。
        // ダイアログの中にフォーカスがあるときは、ダイアログの殻（views/primitives/Dialog.tsx）が Esc を受けて既定を止めるので、二重に出さない。
        // 二重に閉じると、確認から戻った先の未解決のダイアログまで閉じてしまう。
        // ここが受けるのは、フォーカスが器の外（body など）にあるときの Esc だけである。
        case 'overlay.close':
          if (e.defaultPrevented || overlayKind === 'none') return;
          rt.emit(overlayKind === 'palette' ? { type: 'palette.close' } : { type: 'overlay.close' });
          return;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rt, overlayKind, sessionId, shortcutRun, shortcutTabs, selectedTabId, canSplit, newProjectId, newScratch, props.terminals, transcriptShown, finds, reload]);

  // 確認や入力のあるダイアログの裏では、スワイプで画面を移さない（Mediator の canMoveBehind と同じ規則）。
  // Mediator も nav.back を捨てるが、それだけだと矢印が出て「動いた」と見えてしまうので、手勢そのものを受けない。
  // スワイプの効果は rt だけで組み直さないので、いまの値は ref で読む。
  const swipeBlocked = useRef(false);
  swipeBlocked.current = !canMoveBehind(state);
  // デスクトップの殻の中か。スワイプの決め方とマウスの戻る進むのボタンは、殻の中だけで自前で持つ。
  // 殻は起動の時に決まり、途中で変わらないが、効果を rt だけで組むために ref で読む。
  const inShell = useRef(false);
  inShell.current = store.desktop;

  // マウスの戻ると進むのボタン（button 3 と 4）。
  // ⌘[ と ⌘] と同じく、入力欄やターミナルの中でも効く。ダイアログの裏で移さないのは Mediator（canMoveBehind）が、
  // 最初の頁より前へ戻らないのは runtime の history.go が受け持つ。
  // WebView2 は mouseup の既定の動作で履歴を動かすので、それを止めて自前の nav.back に替える。
  // 既定のままだと、最初の頁の手前の起動を待つ頁まで戻って詰む。
  // ブラウザでは、ブラウザの戻る進むに任せる。前の頁が hangar の外にあることもあるからである。
  // xterm などが伝搬を止めても取りこぼさないよう、捕捉の段で受ける。
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if ((e.button !== 3 && e.button !== 4) || !inShell.current) return;
      e.preventDefault();
      rt.emit({ type: e.button === 3 ? 'nav.back' : 'nav.forward' });
    };
    window.addEventListener('mouseup', onMouseUp, true);
    return () => window.removeEventListener('mouseup', onMouseUp, true);
  }, [rt]);

  // トラックパッドの横スワイプ。
  // ネイティブの手勢はスナップショットを滑らせる演出まで付いてくるので使わず、横方向のホイールを自分で積む。
  useEffect(() => {
    const swipe = createSwipeDetector();
    // Windows の殻で、0 の打鍵から指が離れたことを読む。
    const lift = createLiftDetector();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 打鍵の途切れで離したとみなす決め方（Windows の殻）の時計。打鍵のたびに張り直す。離した後は、惰性の途切れを待つ時計になる。
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const mode = () => swipeModeOf({ phaseAware: phaseAware(), desktop: inShell.current, platform: clientPlatform() });
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
    // 新しい手勢の始まり。前の手勢の名残をすべて捨てて、矢印も 0 に戻す。
    const begin = () => {
      ended = false;
      owner = 'none';
      swipe.begin();
      clearTimeout(timer);
      hide();
    };
    const onWheel = (e: WheelEvent) => {
      // ブラウザには元から手勢がある。二重に持たず、標準の戻る進むに任せる。
      // この機能はデスクトップの殻の中だけのものである。
      const m = mode();
      if (m === 'off') return;
      if (m === 'gap') {
        // Windows の Chromium は Shift+ホイールを横の打鍵にして渡す。マウスで横へ流す操作なので、手勢にしない。
        if (e.shiftKey) return;
        // 指を離した瞬間に届く 0 の打鍵を、離した合図にする（swipe.ts の createLiftDetector）。
        // 離した後の惰性と、手勢の外の 0 の打鍵は捨てる。惰性が途切れたら、次の打鍵からは新しい手勢である。
        const step = lift.wheel(e, !ended);
        clearTimeout(releaseTimer);
        if (step !== 'feed') {
          releaseTimer = setTimeout(lift.gap, SWIPE_RELEASE_GAP_MS);
          if (step === 'lift') onRelease();
          return;
        }
        // 位相の無い殻では、途切れた後（か離した後）の最初の打鍵が新しい手勢の始まりである。
        if (ended) begin();
        // 0 の打鍵が来ない環境（高精度でないタッチパッドなど）のために、打鍵の途切れも離した合図として残す。
        releaseTimer = setTimeout(onRelease, SWIPE_RELEASE_GAP_MS);
      }
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
      // 指が離れたことは、macOS の殻では OS の位相が教えてくれる（__hangarSwipeEnd）。
      // 手勢の終わりは合図が決める。位相の届く環境では、時間で画面を動かすことはしない。
      // 時間で打ち切る経路を残すと、合図が遅れた回に、指を置いたまま画面が動く。
      // 位相の無い Windows の殻だけは、上の 0 の打鍵と途切れの時計が合図の代わりになる。
      // ただし身構えていない手勢は、合図を取りこぼしても矢印が居残らないように、消すだけの保険を置く。
      if (!p.armed) timer = setTimeout(hide, SWIPE_STALE_HIDE_MS);
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    phaseWindow().__hangarSwipeBegin = begin;
    phaseWindow().__hangarSwipeEnd = onRelease;
    return () => {
      clearTimeout(timer);
      clearTimeout(releaseTimer);
      window.removeEventListener('wheel', onWheel);
      delete phaseWindow().__hangarSwipeBegin;
      delete phaseWindow().__hangarSwipeEnd;
    };
  }, [rt]);

  const shell = presentShell(state, store, now);
  let body: ReactNode;
  if (!store.bootstrapped || state.screen.name === 'booting') body = <div className="empty boot-wait">{translatorOf(store)('common.state.loading')}</div>;
  else switch (state.screen.name) {
    case 'home': body = <HomeScreen {...presentHomeScreen(state, store, now)} />; break;
    case 'projects': body = <ProjectsScreen {...presentProjects(state, store, now, projectFilter, showArchived)} filter={projectFilter} onFilter={setProjectFilter} onShowArchived={setShowArchived} />; break;
    case 'project': body = <ProjectScreen {...presentProject(state, store, now, state.screen.id)} />; break;
    case 'session': {
      // ペインが 2 つ以上なら分割の本体、1 つなら今までどおりの 1 画面。
      const panes = presentPanes(state, store, now);
      if (panes) { body = <PaneWorkspace panes={panes} />; break; }
      const p = presentSession(state, store, now, state.screen.id);
      // ターミナルの接続の様子は、枠ごとに TerminalPane が Host から読む（分割で片方だけ切れることがある）。
      body = <SessionScreen {...p} />;
      break;
    }
    case 'settings': body = <SettingsScreen {...presentSettings(state, store, now)} />; break;
  }

  // 起動ダイアログはプロジェクトが変わったら作り直す。入力欄が非制御で、defaultValue を作り直しでしか変えられないからである。
  const newSession = presentNewSession(state, store, now);
  // Paused の入力は開くたびに作り直す（札と下書きの初期値を、開いたセッションと入口から取り直すため）。
  const pause = presentPause(state, store, now);
  // セッションを移す先のダイアログ（試作の 2A）。検索の語と選んだ先はダイアログが持つので、開くたびに作り直す。
  const moveSession = presentMoveSession(state, store);
  // 設定の同期のダイアログ（作り直した実装）。開いたときに取った中身（Store の configDetail）から組む。
  const configDialog = presentConfigDialog(state, store);
  // psmux（tmux）が無いときに、セッションを始める操作を止めて出す案内（段 6 の B2）。
  const muxGuide = presentMuxGuide(state, store);
  // 差分のダイアログ（git の表示）。中身は Store の gitChanges、gitDiffs、gitEdits から組む。
  const diffDialog = presentDiffDialog(state, store);
  // エディタが見つからなくて断られた開く操作（試作の 1-3 の B）。
  const editorMissing = presentEditorMissing(store, translatorOf(store));
  const overlays = (
    <>
      {unresolvedId && <ResolveProjectDialog {...presentResolveDialog(store, unresolvedId)} candidates={candidates} onQueryCandidates={queryCandidates} />}
      {newSession && <NewSessionDialog key={newSession.projectId ?? ''} {...newSession} />}
      {overlay.kind === 'palette' && <CommandPalette {...presentPalette(state, store, paletteQuery, now, paletteFound)!} onQuery={setPaletteQuery} />}
      {overlay.kind === 'newProject' && <NewProjectDialog {...presentNewProject(state, store)!} />}
      {overlay.kind === 'addAccount' && <AddAccountDialog {...presentAddAccount(state, store)!} />}
      {overlay.kind === 'projectCandidates' && <ProjectCandidatesDialog {...presentProjectCandidates(state, store, now)!} />}
      {overlay.kind === 'promote' && <PromoteDialog {...presentPromote(state, store)!} />}
      {overlay.kind === 'promoted' && <PromotedDialog {...presentPromoted(state, store)!} />}
      {overlay.kind === 'confirm' && <ConfirmDialog {...presentConfirm(state, store, now)!} />}
      {pause && <PauseDialog key={`${pause.sessionId}:${pause.from}`} {...pause} />}
      {moveSession && <MoveSessionDialog key={moveSession.sessionId} {...moveSession} />}
      {configDialog && <ConfigSyncDialog {...configDialog} />}
      {overlay.kind === 'retention' && <RetentionDialog {...presentRetentionDialog(state, store, now)!} />}
      {overlay.kind === 'shortcuts' && <ShortcutsDialog />}
      {muxGuide && <MuxGuideDialog {...muxGuide} />}
      {diffDialog && <DiffDialog key={diffDialog.sessionId} {...diffDialog} />}
      {editorMissing && <EditorMissing {...editorMissing} />}
      <ToastStack {...presentToasts(state, store, now)} />
      <SwipeHint ref={swipeHintRef} />
    </>
  );

      <PaneDropOverlay />
  return (
    <ActionRoot onAction={rt.emit} background={rt.emit}>
      <TerminalHostContext.Provider value={props.terminals}>
        <CopiedContext.Provider value={state.copied}>
          <PromptAssistContext.Provider value={promptAssist}>
            <LanguageRoot language={storeLanguage(store)}>
              <EditorNameRoot name={editorName(store.settings)}>
                <FindRoot store={finds}><Shell {...shell} overlays={overlays}>{body}</Shell></FindRoot>
              </EditorNameRoot>
            </LanguageRoot>
          </PromptAssistContext.Provider>
        </CopiedContext.Provider>
      </TerminalHostContext.Provider>
    </ActionRoot>
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
