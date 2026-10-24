import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { AskError, debounce, type AskFailure, type Asker, type CommandHit, type FileHit } from '../ask.ts';
import type { Attachment, Attachments } from '../images.ts';
import { exitMs, phaseClass, usePresence } from '../presence.ts';
import { AttachSheet } from './AttachSheet.tsx';
import { Fold } from './Fold.tsx';
import { SuggestSheet, type SuggestView } from './SuggestSheet.tsx';

/** 打ちかけの `/` か `@`。start は記号の位置、caret は打っている所。 */
export type Trigger = { kind: '/' | '@'; q: string; start: number; caret: number };

/**
 * 打っている所の手前にある打ちかけ。行頭か空白の直後の `/` と `@` だけを拾う（PC の指示欄と同じ）。
 * `/` の後ろに `/` が入ったら、パスを書いているとみなして拾わない。
 */
export function findTrigger(value: string, caret: number): Trigger | null {
  const m = /(?:^|\s)([/@])(\S*)$/.exec(value.slice(0, caret));
  if (!m) return null;
  const kind = m[1] as Trigger['kind'];
  const q = m[2] ?? '';
  if (kind === '/' && q.includes('/')) return null;
  return { kind, q, start: caret - q.length - 1, caret };
}

/** 打ちかけを text に置き換え、後ろに空白を 1 つ足す（後ろが空白なら足さない）。caret は空白の後ろ。 */
export function insertAt(value: string, t: Trigger, text: string): { value: string; caret: number } {
  const after = value.slice(t.caret);
  const pad = /^\s/.test(after) ? '' : ' ';
  return { value: value.slice(0, t.start) + text + pad + after, caret: t.start + text.length + 1 };
}

/** 縦に流れる一番近い親。 */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** 押しても欄のフォーカスを外さない（キーボードを閉じない）。 */
const keepFocus = (e: SyntheticEvent): void => e.preventDefault();

const ROW_ON = ['row'];
const NO_ROW: string[] = [];
const mb = (bytes: number): string => (Math.round((bytes / 1024 / 1024) * 10) / 10).toFixed(1);

/** 候補を出せないときの見出しと文。expired は接続の期限切れ（401 expired）。 */
function errorView(reason: AskFailure, pcName: string, what: string, expired = false): SuggestView {
  const manual = `${what}を手で入力しても、そのまま送れます。`;
  switch (reason) {
    case 'pc-offline':
    case 'pc-timeout':
      return { kind: 'error', title: 'PC が応答しません', text: `${pcName} がスリープしているか、hangar が停止しているか、hangar が古いかもしれません。${manual}`, retry: true };
    case 'unsupported':
      return { kind: 'error', title: 'この PC は候補を返せません', text: `hangar を更新してください。${manual}`, retry: false };
    case 'too-large':
      // 同じ問い合わせは何度送っても通らない。
      return { kind: 'error', title: '候補を取得できませんでした', text: manual, retry: false };
    case 'unreadable':
      return { kind: 'error', title: `${pcName} の応答を読み取れませんでした`, text: manual, retry: true };
    case 'rate-limited':
      return { kind: 'error', title: '問い合わせの上限です', text: '少し待ってから、もう一度タップしてください。', retry: true };
    case 'project-missing':
      return { kind: 'error', title: 'その PC にプロジェクトのディレクトリがありません', text: manual, retry: false };
    case 'account-missing':
      return { kind: 'error', title: 'その PC に選んだアカウントがありません', text: manual, retry: false };
    case 'not-found':
      return { kind: 'error', title: `${pcName} はクラウドに参加していません`, text: '別の PC を選んでください。', retry: false };
    case 'unpaired':
      return { kind: 'error', title: expired ? 'このスマホの接続は期限が切れています' : 'このスマホの接続は解除されています', text: manual, retry: false };
    case 'network':
      return { kind: 'error', title: '通信できませんでした', text: `通信を確認してください。${manual}`, retry: true };
    default:
      return { kind: 'error', title: '候補を取得できませんでした', text: manual, retry: true };
  }
}

type Props = {
  /** 欄の id（label の htmlFor）。 */
  id: string;
  value: string;
  onChange: (v: string) => void;
  asker: Asker;
  pc: string | null;
  pcName: string;
  /** クイックセッションなら null。 */
  projectId: string | null;
  projectName: string | null;
  accountId: string | null;
  accountName: string | null;
  attachments: Attachments;
  /** 選んだ PC が `/` と `@` の問い合わせに答えられるか。false なら問い合わせずに、hangar の更新を促す。 */
  canAsk?: boolean;
  /** 選んだ PC と Worker が画像を受け取れるか。false なら「＋」を出さない。 */
  canAttach?: boolean;
};

/** `@` の後ろを問い合わせに載せる長さの上限。長い q で問い合わせの本文の上限（4 KiB）を超えないため。 */
export const FILE_QUERY_MAX = 200;

type Result = { key: string; ok: true; list: CommandHit[] | FileHit[] } | { key: string; ok: false; reason: AskFailure; expired: boolean };

/**
 * 初期プロンプトの欄。欄の上に添付した画像、下に道具の列（「＋」「/」「@」）。
 * `/` と `@` の候補は、キーボードの上のシート（SuggestSheet）に出す。
 */
export function Composer({ id, value, onChange, asker, pc, pcName, projectId, projectName, accountId, accountName, attachments: att, canAsk = true, canAttach = true }: Props): ReactNode {
  const ta = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [retryNo, setRetryNo] = useState(0);
  const [res, setRes] = useState<Result | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const lastFiles = useRef<{ where: string; list: FileHit[] } | null>(null);

  // 候補を入れたあと、打っている所を入れたものの後ろへ動かす。
  useLayoutEffect(() => {
    const c = pendingCaret.current;
    if (c === null) return;
    pendingCaret.current = null;
    ta.current?.setSelectionRange(c, c);
    setCaret(c);
  }, [value]);

  const trig = focused ? findTrigger(value, Math.min(caret, value.length)) : null;
  const trigKey = trig ? `${trig.kind}${trig.start}` : null;
  useEffect(() => {
    setDismissed((d) => (d === trigKey ? d : null));
  }, [trigKey]);
  const open = !!trig && dismissed !== trigKey;

  // 候補のシートが欄を覆わないよう、開いたら欄を流れの上の端へ寄せる。
  // 下の空き（cm-spacer）は欄にフォーカスがある間ずっと置く。シートの開け閉めのたびに流れの長さが変わり、欄が上下に跳ねないため。
  useEffect(() => {
    if (!open) return;
    const b = box.current;
    const sc = scrollParent(b);
    if (!b || !sc) return;
    // 入力の直後はブラウザが打っている所を見せる送りをするので、次の描画まで待ってから送る（先に送ると打ち消される）。
    const raf = requestAnimationFrame(() => {
      const dy = b.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8;
      if (dy <= 0) return;
      if (typeof sc.scrollTo === 'function') sc.scrollTo({ top: sc.scrollTop + dy, behavior: exitMs() > 0 ? 'smooth' : 'auto' });
      else sc.scrollTop += dy;
    });
    return () => cancelAnimationFrame(raf);
    // 打ちかけが変わるたび（開いた、別の打ちかけに移った）に寄せ直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ? trigKey : null]);

  const where = `${pc ?? ''}\n${projectId ?? ''}`;
  const fileQ = trig ? [...trig.q].slice(0, FILE_QUERY_MAX).join('') : '';
  const want = !open || !trig || !pc || !canAsk ? null : trig.kind === '/' ? (accountId ? `/\n${where}\n${accountId}\n${retryNo}` : null) : projectId ? `@\n${where}\n${fileQ}\n${retryNo}` : null;

  useEffect(() => {
    if (!want || !trig || !pc) return;
    let stale = false;
    const key = want;
    const kind = trig.kind;
    const q = fileQ;
    const go = (): void => {
      const p: Promise<CommandHit[] | FileHit[]> = kind === '/' ? asker.commands(pc, projectId, accountId ?? '') : asker.files(pc, projectId ?? '', q);
      p.then(
        (list) => {
          if (stale) return;
          if (kind === '@') lastFiles.current = { where, list: list as FileHit[] };
          setRes({ key, ok: true, list });
        },
        (e: unknown) => {
          if (!stale) setRes({ key, ok: false, reason: e instanceof AskError ? e.reason : 'server', expired: e instanceof AskError && e.unpairedReason === 'expired' });
        },
      );
    };
    if (kind === '@') {
      const d = debounce();
      d.run(go);
      return () => {
        stale = true;
        d.cancel();
      };
    }
    go();
    return () => {
      stale = true;
    };
    // 問い合わせは want（種類、PC、プロジェクト、アカウント、q、再試行の番号）が変わったときだけ出す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);

  let head = '';
  let view: SuggestView | null = null;
  if (open && trig) {
    const loading: SuggestView = { kind: 'loading', pcName };
    if (trig.kind === '/') {
      head = pc ? `${pcName} · ${accountName ?? accountId ?? ''} のスキル` : 'スキルとコマンド';
      if (!pc) view = { kind: 'need', title: '先に PC を選んでください' };
      else if (!canAsk) view = errorView('unsupported', pcName, 'スキルやコマンド');
      else if (!accountId) view = { kind: 'need', title: '先にアカウントを選んでください' };
      else if (res && res.key === want) view = res.ok ? { kind: 'commands', q: trig.q, list: res.list as CommandHit[] } : errorView(res.reason, pcName, 'スキルやコマンド', res.expired);
      else view = loading;
    } else {
      head = pc && projectId ? `${projectName ?? projectId} のファイル · ${pcName}` : 'ファイル';
      if (!projectId) view = { kind: 'need', title: 'プロジェクトを選ぶと、ファイルが表示されます', text: 'クイックセッションでは、パスを手で入力してください。' };
      else if (!pc) view = { kind: 'need', title: '先に PC を選んでください' };
      else if (!canAsk) view = errorView('unsupported', pcName, 'パス');
      else if (res && res.key === want) view = res.ok ? { kind: 'files', q: trig.q, list: res.list as FileHit[] } : errorView(res.reason, pcName, 'パス', res.expired);
      else {
        // 次の答えを待つ間は、前の答えのうち今の q に合うものを残す（打つたびに骨組みへ戻さない）。
        const prev = lastFiles.current && lastFiles.current.where === where ? lastFiles.current.list.filter((f) => f.path.toLowerCase().includes(trig.q.toLowerCase())) : [];
        view = prev.length > 0 ? { kind: 'files', q: trig.q, list: prev } : loading;
      }
    }
  }

  const readCaret = (el: HTMLTextAreaElement): void => setCaret(el.selectionStart ?? el.value.length);

  const pick = (text: string): void => {
    if (!trig) return;
    const r = insertAt(value, trig, text);
    pendingCaret.current = r.caret;
    onChange(r.value);
  };

  /** 道具の列の「/」「@」。打ちかけが同じ種類なら候補を出し直し、そうでなければ打っている所に記号を入れる。 */
  const startTrigger = (k: Trigger['kind']): void => {
    const el = ta.current;
    const c = focused && el ? (el.selectionStart ?? caret) : value.length;
    const end = focused && el ? (el.selectionEnd ?? c) : value.length;
    el?.focus({ preventScroll: true });
    setFocused(true);
    setDismissed(null);
    const t = findTrigger(value, c);
    if (t && t.kind === k && c === end) {
      setCaret(c);
      return;
    }
    const before = value.slice(0, c);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    pendingCaret.current = c + pad.length + 1;
    onChange(before + pad + k + value.slice(end));
  };

  const rowShown = usePresence(att.items.length > 0 || att.notice ? ROW_ON : NO_ROW, (k) => k);
  const n = att.items.length;

  return (
    <>
      <div ref={box} className={`cm-box ${focused ? 'on' : ''}`}>
        {rowShown.map((r) => (
          <Fold key={r.key} phase={r.phase} className="cm-row">
            {n > 0 && <Thumbs att={att} />}
            {att.notice && (
              <p className="strip warn cm-astrip m-fade" role="status">
                {att.notice}
              </p>
            )}
          </Fold>
        ))}
        <textarea
          id={id}
          ref={ta}
          className="cm-ta"
          rows={5}
          value={value}
          placeholder="例：README の導入の節を修正して"
          onChange={(e) => {
            onChange(e.target.value);
            readCaret(e.target);
          }}
          onSelect={(e) => readCaret(e.currentTarget)}
          onFocus={(e) => {
            setFocused(true);
            readCaret(e.currentTarget);
          }}
          onBlur={() => setFocused(false)}
        />
        {n > 0 && <p className="cm-anote">{`${n}/4 枚`}</p>}
        <div className="cm-tools">
          {canAttach && (
            <button type="button" className="cm-tl plus" aria-label="画像を添付" onClick={() => setAttachOpen(true)}>
              ＋
            </button>
          )}
          <button type="button" className="cm-tl key" aria-label="スキルとコマンド" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => startTrigger('/')}>
            /
          </button>
          <button type="button" className="cm-tl key" aria-label="ファイル" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => startTrigger('@')}>
            @
          </button>
        </div>
      </div>
      {focused && <div className="cm-spacer" aria-hidden="true" />}
      <SuggestSheet open={open} head={head} view={view} onPick={pick} onRetry={() => setRetryNo((x) => x + 1)} onDismiss={() => setDismissed(trigKey)} />
      <AttachSheet open={attachOpen && canAttach} onClose={() => setAttachOpen(false)} onFiles={(files) => void att.add(files)} />
    </>
  );
}

/** 添付した画像のサムネイル。入るときは膨らんで現れ、外すときは縮んで消える。 */
function Thumbs({ att }: { att: Attachments }): ReactNode {
  const list = usePresence(att.items, (a) => String(a.id));
  return (
    <ul className="cm-thumbs" aria-label="添付した画像">
      {list.map((p) => (
        <Thumb key={p.key} a={p.item} phase={phaseClass(p.phase)} leaving={p.phase === 'leave'} att={att} />
      ))}
    </ul>
  );
}

function Thumb({ a, phase, leaving, att }: { a: Attachment; phase: string; leaving: boolean; att: Attachments }): ReactNode {
  return (
    <li className={`cm-th ${a.state} ${phase}`} aria-hidden={leaving ? true : undefined}>
      <img src={a.url} alt="" />
      {a.state !== 'fail' && <span className="cm-sz">{mb(a.data.length)} MB</span>}
      {a.state === 'up' && (
        <>
          <span className="cm-ov" aria-hidden="true">
            {a.pct}%
          </span>
          <span className="cm-pb" aria-hidden="true">
            <i style={{ width: `${a.pct}%` }} />
          </span>
        </>
      )}
      {a.state === 'done' && (
        <span className="cm-ok" role="img" aria-label="送信済み">
          ✓
        </span>
      )}
      {a.state === 'fail' && (
        <button type="button" className="cm-ov cm-retry" aria-label={`${a.name} をもう一度送信`} onClick={() => att.retry(a.id)}>
          <b>!</b>再送
        </button>
      )}
      <button type="button" className="cm-x" aria-label={`${a.name} を削除`} onClick={() => att.remove(a.id)}>
        ✕
      </button>
    </li>
  );
}
