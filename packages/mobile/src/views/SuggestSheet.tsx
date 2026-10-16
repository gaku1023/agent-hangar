import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import type { CommandHit, FileHit } from '../ask.ts';
import { useSheetPhase } from '../presence.ts';

/** シートの中身。 */
export type SuggestView =
  | { kind: 'need'; title: string; text: string }
  | { kind: 'loading'; pcName: string }
  | { kind: 'error'; title: string; text: string; retry: boolean }
  | { kind: 'commands'; q: string; list: CommandHit[] }
  | { kind: 'files'; q: string; list: FileHit[] };

type Props = {
  open: boolean;
  head: string;
  view: SuggestView | null;
  /** 押した候補（「/名前」か「@パス」）。 */
  onPick: (text: string) => void;
  onRetry: () => void;
  /** ×と「手で入力する」。 */
  onDismiss: () => void;
};

/** 欄から指を離しても文字の入力を続けられるよう、シートを押しても欄のフォーカスを外さない。 */
const keepFocus = (e: SyntheticEvent): void => e.preventDefault();

/**
 * キーボードが占める高さ。visualViewport が縮んだ分を、画面の下からの位置に使う。
 * visualViewport の無いブラウザでは 0（画面の下に出す）。
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = (): void => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

/** q に合う所を強める。HTML として読ませない（文字のまま並べる）。 */
function Hl({ text, q }: { text: string; q: string }): ReactNode {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** 名前の頭が合う、名前のどこかが合う、説明が合う、の順。合わないものは 3。 */
function rankOf(c: CommandHit, q: string): number {
  if (!q) return 0;
  const n = c.name.toLowerCase();
  const l = q.toLowerCase();
  if (n.startsWith(l)) return 0;
  if (n.includes(l)) return 1;
  if (c.description.toLowerCase().includes(l)) return 2;
  return 3;
}

function Commands({ q, list, onPick }: { q: string; list: CommandHit[]; onPick: (t: string) => void }): ReactNode {
  const group = (title: string, kind: CommandHit['kind']): ReactNode => {
    const rows = list
      .filter((c) => c.kind === kind)
      .map((c) => ({ c, r: rankOf(c, q) }))
      .filter((x) => x.r < 3)
      .sort((a, b) => a.r - b.r);
    if (rows.length === 0) return null;
    return (
      <div role="group" aria-label={title}>
        <div className="cm-cg">{title}</div>
        {rows.map(({ c }) => (
          <button key={`${c.kind}:${c.name}`} type="button" className="cm-crow" onClick={() => onPick(`/${c.name}`)}>
            <b>
              /<Hl text={c.name} q={q} />
            </b>
            {c.description && <span>{c.description}</span>}
          </button>
        ))}
      </div>
    );
  };
  const skills = group('スキル', 'skill');
  const commands = group('コマンド', 'command');
  if (!skills && !commands) {
    return (
      <div className="cm-empty">
        {q ? `「/${q}」に合うスキルはありません。` : 'この PC とアカウントにスキルはありません。'}
        <br />
        そのまま文として送ることもできます。
      </div>
    );
  }
  return (
    <>
      {skills}
      {commands}
    </>
  );
}

function Files({ q, list, onPick }: { q: string; list: FileHit[]; onPick: (t: string) => void }): ReactNode {
  if (list.length === 0) {
    return <div className="cm-empty">{q ? `「${q}」に合うファイルはありません。` : '最近変更したファイルはありません。名前を入力すると探せます。'}</div>;
  }
  return (
    <>
      <div className="cm-cg">{q ? `「${q}」に合うファイル` : '最近変更したファイル'}</div>
      {list.map((f) => {
        const i = f.path.lastIndexOf('/');
        const dir = i < 0 ? '' : f.path.slice(0, i + 1);
        const base = f.path.slice(i + 1);
        return (
          <button key={f.path} type="button" className="cm-frow" onClick={() => onPick(`@${f.path}`)}>
            <span className="cm-fic" aria-hidden="true">
              ▤
            </span>
            <span className="cm-fnm">
              <b>
                <Hl text={base} q={q} />
              </b>
              <span>{dir || '（直下）'}</span>
            </span>
            {f.changed && <span className="cm-md">変更</span>}
          </button>
        );
      })}
      {!q && <p className="cm-foot">ほかのファイルは、続けて名前を入力すると探せます。</p>}
    </>
  );
}

function Body({ view, onPick, onRetry, onDismiss }: { view: SuggestView } & Pick<Props, 'onPick' | 'onRetry' | 'onDismiss'>): ReactNode {
  switch (view.kind) {
    case 'need':
      return (
        <div className="cm-empty">
          <b>{view.title}</b>
          <br />
          {view.text}
        </div>
      );
    case 'loading':
      return (
        <>
          <div className="cm-wait" role="status">
            <span className="cm-spin" aria-hidden="true" />
            <span>
              {view.pcName} に問い合わせ中…<small>1〜3 秒かかります</small>
            </span>
          </div>
          <div className="cm-sk" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </>
      );
    case 'error':
      return (
        <div className="strip danger cm-err" role="alert">
          <b>{view.title}</b>
          {view.text}
          <div className="cm-err-row">
            {view.retry && (
              <button type="button" className="cm-btn" onClick={onRetry}>
                もう一度
              </button>
            )}
            <button type="button" className="cm-btn" onClick={onDismiss}>
              手で入力する
            </button>
          </div>
        </div>
      );
    case 'commands':
      return <Commands q={view.q} list={view.list} onPick={onPick} />;
    case 'files':
      return <Files q={view.q} list={view.list} onPick={onPick} />;
  }
}

/**
 * `/` と `@` の候補のシート。キーボードのすぐ上に、下から上がって出る。
 * 閉じる間は、最後の中身のまま下がって消える。
 */
export function SuggestSheet({ open, head, view, onPick, onRetry, onDismiss }: Props): ReactNode {
  const { mounted, leaving } = useSheetPhase(open && !!view);
  const inset = useKeyboardInset();
  const last = useRef<{ head: string; view: SuggestView } | null>(null);
  if (open && view) last.current = { head, view };
  const shown = last.current;
  if (!mounted || !shown) return null;
  return (
    <section
      className={`cm-sheet ${leaving ? 'leaving' : ''}`}
      aria-label="候補"
      style={{ bottom: inset }}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      inert={leaving}
    >
      <div className="cm-chd">
        <span>{shown.head}</span>
        <button type="button" className="cm-cx" aria-label="候補を閉じる" onClick={onDismiss}>
          ✕
        </button>
      </div>
      <div className="cm-cbody">
        <Body view={shown.view} onPick={onPick} onRetry={onRetry} onDismiss={onDismiss} />
      </div>
    </section>
  );
}
