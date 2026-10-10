import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PromptCommandDto } from '@agent-hangar/shared';
import { FILE_DRAG_EVENT, FILE_DROP_EVENT, parseDrag, parseDrop } from '../../runtime/fileDrop.ts';
import { isComposing } from '../ime.ts';
import { fitHeight, highlight, place, type Placement } from './listboxModel.ts';
import { Icon } from './Icon.tsx';
import { useT } from './language.tsx';
import { keyLabel } from '../../keys.ts';
import { splitLast } from '../../lib/paths.ts';
import { AttachUnavailableError, PromptAssistContext } from './promptAssist.ts';
import { acceptText, arrangeCommands, attachmentFromPath, dropFileName, formatSize, isImageName, sourceLabel, triggerAt, type Attachment, type Trigger } from './promptComposerModel.ts';

/** 候補の一覧の高さの上限（px）。controls.css の .pc-pop の max-height（300px）と同じ値なので、変えるなら両方を変える。 */
const POP_MAX_HEIGHT = 300;
/** 欄が伸びる高さの上限（px）。超えたら中で送る。 */
const MAX_HEIGHT = 240;
/** 添付 1 件の上限。サーバ（prompt/drops.ts の MAX_DROP_BYTES）と同じ。 */
const MAX_BYTES = 20 * 1024 * 1024;
/** @ の問いを送るまでに待つ時間（ms）。 */
const FILE_DEBOUNCE_MS = 120;
/** 置き場へ送っている最中の添付。終わっても先の送信が残っている間は、result を持って待つ。 */
type Pending = { id: number; name: string; result?: Attachment };
const keyOf = (t: Trigger) => `${t.kind}${t.start}:${t.query}`;

/** 添付 1 件の札。絵が読めなければ（置き場から消えた、など）、拡張子の印に替える。 */
function AttachmentCard(props: { attachment: Attachment; onRemove: () => void }) {
  const t = useT();
  const a = props.attachment;
  const [broken, setBroken] = useState(false);
  const file = isImageName(a.name) ? dropFileName(a.path) : null;
  const ext = a.name.includes('.') ? a.name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE';
  return (
    <li className="pc-card" aria-label={a.name} title={a.path}>
      {file && !broken
        ? <img className="pc-thumb" src={`/api/drops/${encodeURIComponent(file)}`} alt="" onError={() => setBroken(true)} />
        : <span className="pc-thumb pc-thumb-doc" aria-hidden="true">{ext}</span>}
      <span className="pc-card-text"><b>{a.name}</b>{a.size !== null && <small>{formatSize(a.size)}</small>}</span>
      <button type="button" className="pc-card-x" aria-label={t('composer.card.remove', { name: a.name })} onClick={props.onRemove}><Icon name="close" /></button>
    </li>
  );
}

function Marked(props: { text: string; query: string }) {
  return <>{highlight(props.text, props.query).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}</>;
}

/**
 * 初期プロンプトの欄。先頭の / でスキルとコマンドの候補を、先頭か空白の直後の @ でプロジェクトのファイルの候補を出す。
 * 候補が開いている間だけ、↑↓・Enter・Tab・Esc をここで受けて外へ伝えない。
 * 閉じている間の打鍵は外（起動ダイアログ）へそのまま流す。Enter の改行と ⌘Enter の起動を変えないためである。
 * 貼り付け、ドロップ、添付ボタンで受けたファイルは置き場へ送り、欄の下に札で並べる（パスを文に足すのは起動のとき）。
 * hero は新しいセッションのダイアログの主役の欄で、高さを 150px から始め、ダイアログを開いたときの焦点を受ける（data-autofocus）。placeholder は空のときの案内である。
 * 候補はダイアログの外（body）に描く。ダイアログは backdrop-filter を持ち、中の fixed はダイアログ基準になるからである（Listbox と同じ）。
 */
export function PromptComposer(props: { id: string; value: string; onChange: (value: string) => void; projectId: string | null; attachments: Attachment[]; onAttachmentsChange: (next: Attachment[]) => void; onPendingChange?: (count: number) => void; hero?: boolean; placeholder?: string }) {
  const t = useT();
  const assist = useContext(PromptAssistContext);
  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [commands, setCommands] = useState<PromptCommandDto[] | 'failed' | null>(null);
  const [files, setFiles] = useState<{ project: string; start: number; query: string; list: string[] | 'failed' } | null>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // Esc で閉じたきっかけ。同じ語のままなら開き直さない。
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Placement | null>(null);
  // ファイルを運んでいる最中に、落とせる欄として色を変える。
  const [dropping, setDropping] = useState(false);
  // 確定の後に置くカーソルの位置。値が描かれてから置く。
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setCommands(null);
    assist.commands(props.projectId).then((c) => { if (live) setCommands(c); }, () => { if (live) setCommands('failed'); });
    return () => { live = false; };
  }, [assist, props.projectId]);

  // 焦点が外れても、Esc で閉じたきっかけは覚えておく（戻ったときに開き直さない）。
  const rawTrigger = triggerAt(props.value, caret);
  const trigger = focused ? rawTrigger : null;
  // スキルの名前に / は入らない。貼ったパス（/Users/x）の下に「一致なし」を出しても邪魔なので、/ は語に / があれば開かない。
  // @ の語はパスなので / が入るのがふつうで、その規則は持ち込まない。@ はプロジェクトのファイルを探すので、プロジェクトが無い（スクラッチ）ときは出さない。
  const open = trigger !== null && (trigger.kind === '/' ? !trigger.query.includes('/') : props.projectId !== null) && dismissed !== keyOf(trigger);
  const mode = open ? trigger.kind : null;
  const sections = mode === '/' && Array.isArray(commands) ? arrangeCommands(t, commands, trigger!.query) : [];

  // @ の候補。問いごとに読み、古い返事は捨てる。
  // 新しい返事を待つ間は、同じ @（同じプロジェクト、同じ位置）の前の問いの一覧（空でないもの）を出したままにする。打鍵のたびに「読み込んでいます」へ替わると、一覧がちらつくためである。
  // ただし前の問いの一覧は見せるだけで、入れられない（stale）。いま打った語の候補ではないので、Enter や Tab で入れると、打った語と関係ないファイルが入る。
  const fileQuery = mode === '@' ? trigger!.query : null;
  const mentionStart = mode === '@' ? trigger!.start : null;
  const own = files !== null && files.project === props.projectId && files.start === mentionStart ? files : null;
  const shown = own && own.query === fileQuery ? own : own && Array.isArray(own.list) && own.list.length > 0 ? own : null;
  const fileList = shown?.list ?? null;
  const stale = shown !== null && shown.query !== fileQuery;
  const flat: string[] = mode === '/' ? sections.flatMap((s) => s.items.map((c) => c.name)) : Array.isArray(fileList) && !stale ? fileList : [];
  const current = Math.min(active, Math.max(flat.length - 1, 0));
  // @ の候補が、いまの問いの返事をまだ受けていない（前の問いの一覧を残している、または最初の読み込み中）。
  // 読めなかった（failed）や一致なしは、返事を受けたあとなので含めない。
  const waiting = mode === '@' && (shown === null || stale);

  // きっかけが消えたか別の語になったら、Esc の記憶を捨てる。消して打ち直した `/` で開けるようにするためである。
  const rawKey = rawTrigger ? keyOf(rawTrigger) : null;
  useEffect(() => { if (dismissed !== null && dismissed !== rawKey) setDismissed(null); }, [dismissed, rawKey]);

  // 一覧は 1 つの @ の間だけ持つ。閉じる（Esc、確定、焦点が外れる）か別の @ に移ったら捨てる。無関係な一覧を、新しい @ の最初に見せないためである。
  useEffect(() => { setFiles(null); }, [mentionStart, props.projectId]);

  // 問いは打鍵のたびに送らず、少し待って打ち終わった語だけ送る（サーバは同じプロジェクトの仕事をまとめるが、往復そのものを減らす）。
  // 問いが空（@ だけ、「ファイル」ボタン）なら、最近変えたファイルをすぐ見せたいので待たない。
  useEffect(() => {
    if (fileQuery === null || mentionStart === null || props.projectId === null) return;
    const project = props.projectId;
    let live = true;
    const run = () => {
      assist.files(project, fileQuery).then(
        (list) => { if (live) setFiles({ project, start: mentionStart, query: fileQuery, list }); },
        () => { if (live) setFiles({ project, start: mentionStart, query: fileQuery, list: 'failed' }); },
      );
    };
    if (fileQuery === '') run();
    const timer = fileQuery === '' ? null : setTimeout(run, FILE_DEBOUNCE_MS);
    // 次の問いに移ったら、この問いの返事は捨てる。待っている問いも取り消す。
    return () => { live = false; if (timer !== null) clearTimeout(timer); };
  }, [assist, fileQuery, mentionStart, props.projectId]);

  const picker = useRef<HTMLInputElement>(null);
  // 送っている間に次の添付が来ても取りこぼさないよう、いまの一覧は ref で読む。
  const atts = useRef(props.attachments);
  atts.current = props.attachments;
  // 送っている最中の送信が終わるのは、ダイアログが閉じた後かもしれない。そのとき閉じる前の関数を呼ばないよう、いまの関数を ref で読む。
  const changed = useRef(props.onAttachmentsChange);
  changed.current = props.onAttachmentsChange;
  const pendingChanged = useRef(props.onPendingChange);
  pendingChanged.current = props.onPendingChange;
  const add = (more: Attachment[]) => {
    const have = new Set(atts.current.map((a) => a.path));
    const fresh = more.filter((a) => !have.has(a.path));
    if (!fresh.length) return;
    atts.current = [...atts.current, ...fresh];
    changed.current(atts.current);
  };
  const remove = (path: string) => { atts.current = atts.current.filter((a) => a.path !== path); changed.current(atts.current); };

  // 送っている最中の送信。札は渡された順に出したいので、後のものが先に終わっても、先のものが終わるまで確定を待つ（result を持って待つ）。
  const [pending, setPending] = useState<Pending[]>([]);
  const queue = useRef<Pending[]>([]);
  const reported = useRef(0);
  const setQueue = (next: Pending[]) => {
    queue.current = next;
    setPending(next);
    if (next.length !== reported.current) { reported.current = next.length; pendingChanged.current?.(next.length); }
  };
  // 先頭から、終わっているものを順に確定する。
  const settle = () => {
    const q = [...queue.current];
    const done: Attachment[] = [];
    while (q[0]?.result) done.push(q.shift()!.result!);
    if (done.length) add(done);
    setQueue(q);
  };
  const nextId = useRef(0);

  /** 貼り付け、ブラウザでのドロップ、添付ボタンのどれも、ここで置き場へ送る。 */
  const send = (files: File[]) => {
    for (const f of files) {
      if (f.size > MAX_BYTES) { assist.notify(t('composer.attach.tooLarge', { name: f.name })); continue; }
      const id = nextId.current++;
      setQueue([...queue.current, { id, name: f.name }]);
      assist.upload(f).then(
        (d) => {
          queue.current = queue.current.map((p) => (p.id === id ? { ...p, result: { path: d.path, name: d.name, size: d.size } } : p));
          settle();
        },
        (e: unknown) => {
          assist.notify(t('composer.attach.failed', { name: f.name, reason: e instanceof AttachUnavailableError ? t('composer.attach.unavailable') : e instanceof Error ? e.message : String(e) }));
          queue.current = queue.current.filter((p) => p.id !== id);
          settle();
        },
      );
    }
  };

  // 殻（Hangar.app）からのドロップ。殻が置き場に写した先のパスを送ってくるので、落とした位置がこの欄なら添付にする。
  // 端末に落としたときは main.tsx の受け口が貼り付ける。行き先が重ならないよう、ここは欄の中だけを見る。
  // 殻の窓では Web 側にドラッグのイベントが来ないので、運んでいる間の位置も殻から受けて、欄の上かどうかで色を変える。
  // 位置は 1 秒に何十回も来る。値が変わらなければ React は描き直さない。
  useEffect(() => {
    const onDrag = (e: Event) => {
      const d = parseDrag((e as CustomEvent).detail);
      const hit = d && box.current ? document.elementFromPoint(d.x, d.y) : null;
      setDropping(!!hit && !!box.current?.contains(hit));
    };
    const onDrop = (e: Event) => {
      // 殻は写し終わってから届けるので、色はここで確実に戻す。
      setDropping(false);
      const d = parseDrop((e as CustomEvent).detail);
      if (!d || !box.current) return;
      const hit = document.elementFromPoint(d.x, d.y);
      if (!hit || !box.current.contains(hit)) return;
      add(d.paths.map(attachmentFromPath));
      ta.current?.focus();
    };
    window.addEventListener(FILE_DRAG_EVENT, onDrag);
    window.addEventListener(FILE_DROP_EVENT, onDrop);
    return () => {
      window.removeEventListener(FILE_DRAG_EVENT, onDrag);
      window.removeEventListener(FILE_DROP_EVENT, onDrop);
    };
    // add は ref と props の関数しか使わない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ブラウザで欄を少し外してファイルを落とすと、ページがそのファイルへ移り、書きかけの内容が消える。
  // ページのどこでも、ファイルを運んでいる間は既定の動きだけを止める。欄の外では何も添付しない。
  // 欄の自分の処理は、伝わる途中（バブリング）で先に動くので、ここは邪魔にならない。
  useEffect(() => {
    const guard = (e: DragEvent) => { if (e.dataTransfer?.types?.includes?.('Files')) e.preventDefault(); };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => { window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard); };
  }, []);

  // 下書きから戻した添付は、置き場の掃除（7 日）で消えていることがある。開いたときに 1 度だけ確かめて外す。
  // 確かめられなかったときは残す。消えたと決めつけて外すより、起動の文に残るほうが害が小さい。
  useEffect(() => {
    const first = atts.current;
    if (!first.length) return;
    let live = true;
    assist.existing(first.map((a) => a.path)).then((alive) => {
      if (!live) return;
      const keep = new Set(alive);
      const next = atts.current.filter((a) => keep.has(a.path) || !first.some((f) => f.path === a.path));
      if (next.length !== atts.current.length) { atts.current = next; changed.current(next); }
    }, () => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncCaret = () => { const el = ta.current; if (el) setCaret(el.selectionStart ?? el.value.length); };

  // 行数に合わせて伸ばす。上限を超えたら中で送る。
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  }, [props.value]);

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !ta.current) return;
    pendingCaret.current = null;
    ta.current.setSelectionRange(at, at);
    setCaret(at);
  }, [props.value]);

  // 測る → 上下を決める → 開く側の高さに収める、の順に置く。
  // 上限は DOM に直に書く（React の style には持たせない）。測り直すたびに上限をいったん戻すので、React の前回の値と食い違うからである。
  // 収める前の高さで上下を決めるので、収めた高さで測り直して決め直す（行き来する）ことはない。
  const reposition = () => {
    const b = box.current?.getBoundingClientRect();
    if (!b) return;
    const el = pop.current;
    // 上限を戻して測ると、行の入れ物の scrollTop の最大が小さくなり、ブラウザが scrollTop を詰める。上限を掛け直した後で元に戻す。
    const rows = el?.querySelector<HTMLElement>('.listbox-rows');
    const scrolled = rows?.scrollTop ?? 0;
    if (el) el.style.maxHeight = `${POP_MAX_HEIGHT}px`;
    const face = { top: b.top, bottom: b.bottom, left: b.left, width: b.width };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const next = place(face, el?.offsetHeight ?? 0, viewport);
    // 窓の外へ出ると、先頭の行（見出しと選ばれた候補）が見えなくなる。行は一覧の中で送れる。
    if (el) el.style.maxHeight = `${fitHeight(face, viewport, next.up, POP_MAX_HEIGHT)}px`;
    if (rows && rows.scrollTop !== scrolled) rows.scrollTop = scrolled;
    setPos(next);
  };
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    reposition();
    // scroll は捕捉の段で受けるので、一覧自身の行のスクロールも届く。それで測り直すと scrollTop を押し戻すので、一覧の中のものは見ない。
    const onScroll = (e: Event) => { if (e.target instanceof Node && pop.current?.contains(e.target)) return; reposition(); };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', onScroll, true); };
    // 行の数が変わると高さが変わるので、置き直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flat.length, props.value]);

  useEffect(() => { setActive(0); }, [trigger?.kind, trigger?.query]);
  useEffect(() => {
    if (open) pop.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, current]);

  // カーソルを置く。値が変わるときは、描かれてから置く（pendingCaret）。
  // 値が変わらないときは描き直しが無く、pendingCaret が残って次の打鍵でカーソルが跳ぶので、その場で置く。
  const placeCaret = (at: number, changed: boolean) => {
    if (changed) pendingCaret.current = at;
    else { pendingCaret.current = null; ta.current?.setSelectionRange(at, at); }
    setCaret(at);
  };

  const accept = (name: string) => {
    if (!trigger) return;
    const next = acceptText(props.value, caret, trigger, name);
    const changed = next.text !== props.value;
    placeCaret(next.caret, changed);
    if (changed) props.onChange(next.text);
    ta.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (isComposing(e)) {
      // 変換の確定と取り消しは IME に任せるが、外（起動ダイアログの Esc と Enter）へは漏らさない。
      if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
      return;
    }
    const n = flat.length;
    switch (e.key) {
      // 行が無いときの ↑↓ は、複数行の欄でカーソルを動かす打鍵として残す。
      case 'ArrowDown': if (!n) return; setActive((current + 1) % n); break;
      case 'ArrowUp': if (!n) return; setActive((current - 1 + n) % n); break;
      case 'Enter':
        // ⌘Enter は起動なので、候補が開いていても外へ流す。
        if (e.metaKey || e.ctrlKey) return;
        // @ の返事を待つ間に通すと、Enter が改行になり、@ の語がそこで終わってしまう。何も入れず、改行もせず、外へも出さない。
        if (waiting) break;
        if (!n) return;
        accept(flat[current]!);
        break;
      // Shift+Tab は逆向きの移動なので、候補を入れずに通す。
      case 'Tab':
        if (e.shiftKey) return;
        if (waiting) break;
        if (!n) return;
        accept(flat[current]!);
        break;
      case 'Escape': setDismissed(keyOf(trigger!)); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const startSlash = () => {
    const el = ta.current;
    if (!el) return;
    const next = props.value.startsWith('/') ? props.value : `/${props.value}`;
    placeCaret(1, next !== props.value);
    setDismissed(null);
    setFocused(true);
    if (next !== props.value) props.onChange(next);
    el.focus();
  };

  // カーソルの位置に @ を入れる。前が空白でなければ空白を挟む（語の途中の @ ではきっかけにならないため）。
  const startAt = () => {
    const el = ta.current;
    if (!el) return;
    const at = el.selectionStart ?? props.value.length;
    const before = props.value.slice(0, at);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    placeCaret(at + pad.length + 1, true);
    setDismissed(null);
    setFocused(true);
    props.onChange(`${before}${pad}@${props.value.slice(at)}`);
    el.focus();
  };

  const listId = `${props.id}-suggest`;
  let index = 0;
  return (
    <div className="pc" data-hero={props.hero ? 'true' : undefined}>
      <div ref={box} className="pc-box" data-drop={dropping ? 'true' : undefined}
        onDragOver={(e) => { if (!e.dataTransfer?.types?.includes?.('Files')) return; e.preventDefault(); setDropping(true); }}
        // 欄の中の子（textarea とボタン）の間を渡るときも dragleave は来る。行き先が欄の中なら、色は消さない。
        onDragLeave={(e) => { if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return; setDropping(false); }}
        onDrop={(e) => { setDropping(false); const files = [...(e.dataTransfer?.files ?? [])]; if (!files.length) return; e.preventDefault(); send(files); }}>
        <textarea
          ref={ta} id={props.id} className="pc-input" rows={4} value={props.value} placeholder={props.placeholder} data-autofocus={props.hero ? 'true' : undefined}
          // role は textbox のままにする。combobox にすると、複数行の入力として読まれなくなり、既存の画面の探し方（textbox）も変わる。
          // 候補が開いていることは aria-controls と aria-activedescendant で伝える。
          aria-autocomplete="list" aria-controls={open ? listId : undefined}
          aria-activedescendant={open && flat.length ? `${listId}-${current}` : undefined}
          onChange={(e) => { setCaret(e.target.selectionStart ?? e.target.value.length); props.onChange(e.target.value); }}
          onSelect={syncCaret} onKeyUp={syncCaret} onClick={syncCaret}
          onFocus={() => { setFocused(true); syncCaret(); }} onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (!files.length) return;
            // 表計算や文書ソフトからのコピーは、セルの絵と文字を一緒に置く。絵だけ添付にして文字を捨てると、文字を貼れなくなる。
            // Finder でファイルをコピーしたときの文字はファイル名そのものなので、貼らずに捨てる（名前の行が文に混ざらないように）。
            const text = e.clipboardData?.getData?.('text/plain') ?? '';
            const names = new Set(files.map((f) => f.name));
            const onlyNames = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).every((l) => names.has(l));
            if (!(text.trim() && !onlyNames)) e.preventDefault();
            send(files);
          }}
        />
        <div className="pc-tools">
          <button type="button" className="pc-tool" onMouseDown={(e) => e.preventDefault()} onClick={startSlash}><span className="pc-tool-key" aria-hidden="true">/</span>{t('composer.tool.skill')}</button>
          <button type="button" className="pc-tool" disabled={props.projectId === null} title={props.projectId === null ? t('composer.tool.fileNeedsProject') : undefined} onMouseDown={(e) => e.preventDefault()} onClick={startAt}><span className="pc-tool-key" aria-hidden="true">@</span>{t('composer.tool.file')}</button>
          <button type="button" className="pc-tool" onClick={() => picker.current?.click()}><Icon name="attach" />{t('composer.tool.attach')}</button>
          <span className="pc-tools-hint">{t('composer.tool.pasteHint', { keys: keyLabel('⌘V') })}</span>
          <input ref={picker} type="file" multiple hidden data-testid="pc-picker" onChange={(e) => { send([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </div>
        {open && createPortal(
          <div ref={pop} className="listbox-pop pc-pop" data-up={pos?.up ? 'true' : undefined}
            // 一覧の余白やスクロールバーを押しても、欄のフォーカスを奪わない（奪うと blur で一覧が閉じる）。
            onMouseDown={(e) => e.preventDefault()}
            style={pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom } : { visibility: 'hidden' }}>
            <div id={listId} role="listbox" aria-label={mode === '@' ? t('composer.list.fileLabel') : t('composer.list.commandLabel')} className="listbox-rows" data-stale={stale ? 'true' : undefined}>
              {mode === '/' && (
                <>
                  {commands === null && <div className="listbox-empty">{t('common.state.loading')}</div>}
                  {commands === 'failed' && <div className="listbox-empty">{t('composer.list.failed')}</div>}
                  {Array.isArray(commands) && !flat.length && <div className="listbox-empty">{t('common.empty.noMatch')}</div>}
                  {sections.map((s, si) => (
                    <div key={s.title ?? 'hit'} role={s.title ? 'group' : undefined} aria-labelledby={s.title ? `${listId}-g${si}` : undefined}>
                      {s.title && <div id={`${listId}-g${si}`} className="listbox-group-title">{s.title}</div>}
                      {s.items.map((c) => {
                        const i = index++;
                        return (
                          // 欄のフォーカスを奪わないよう、押した時点で確定する。右や中のボタンでは入れない（focus は、どのボタンでも preventDefault で守る）。
                          <div key={c.name} id={`${listId}-${i}`} role="option" aria-selected={i === current} aria-label={`/${c.name}`} data-value={c.name} data-active={i === current ? 'true' : undefined}
                            className="listbox-opt" onMouseDown={(e) => { e.preventDefault(); if (e.button === 0) accept(c.name); }} onMouseMove={() => { if (i !== current) setActive(i); }}>
                            <span className="listbox-opt-main">
                              <span className="pc-cmd">/<Marked text={c.name} query={trigger!.query} />{c.argumentHint && <span className="pc-arg">{c.argumentHint}</span>}</span>
                              {c.description && <small data-kind="prose" className="pc-desc">{c.description}</small>}
                            </span>
                            <span className="pc-src" data-source={c.source}>{sourceLabel(t, c.source)}</span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
              {mode === '@' && (
                <>
                  {fileList === null && <div className="listbox-empty">{t('common.state.loading')}</div>}
                  {fileList === 'failed' && <div className="listbox-empty">{t('composer.list.failed')}</div>}
                  {Array.isArray(fileList) && !fileList.length && <div className="listbox-empty">{t('common.empty.noMatch')}</div>}
                  {/* 見出しは、その一覧を引いた問いが空のときだけ。前の問いの一覧を残している間に、いまの問いへ「最近変えた」を付けない。 */}
                  {Array.isArray(fileList) && fileList.length > 0 && shown?.query === '' && <div className="listbox-group-title">{t('composer.list.recentFiles')}</div>}
                  {Array.isArray(fileList) && fileList.map((f, i) => {
                    // 候補はサーバが / で区切って返す。問いは Windows では \ で打たれることもあるので、どちらの区切りでも最後の名前を光らせる。
                    const { dir, base } = splitLast(f);
                    const q = trigger!.query;
                    // 前の問いの一覧（stale）の行は、選ばれた印を持たず、押しても入らない（欄のフォーカスだけは奪わない）。
                    const on = !stale && i === current;
                    return (
                      <div key={f} id={`${listId}-${i}`} role="option" aria-selected={on} aria-label={f} data-value={f} data-active={on ? 'true' : undefined}
                        className="listbox-opt pc-file" onMouseDown={(e) => { e.preventDefault(); if (!stale && e.button === 0) accept(f); }} onMouseMove={() => { if (!stale && i !== current) setActive(i); }}>
                        <span className="pc-file-name"><Marked text={base} query={splitLast(q).base} /></span>
                        {dir !== '' && <span className="pc-file-dir">{dir.slice(0, -1)}</span>}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
      </div>
      {(props.attachments.length > 0 || pending.length > 0) && (
        <ul className="pc-cards" aria-label={t('composer.cards.label')}>
          {props.attachments.map((a) => <AttachmentCard key={a.path} attachment={a} onRemove={() => remove(a.path)} />)}
          {pending.map((p) => (
            <li key={`pending-${p.id}`} className="pc-card" aria-label={p.name} aria-busy="true">
              <span className="pc-thumb pc-thumb-doc" aria-hidden="true" />
              <span className="pc-card-text"><b>{p.name}</b><small>{t('composer.card.sending')}</small></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
