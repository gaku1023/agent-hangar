import { useCallback, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { isComposing } from '../ime.ts';
import { Icon, type IconName } from './Icon.tsx';

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]';

/** 畳んだ詳細（details）の中にあって、見えていない要素か。見出し（summary）だけは畳んでいても押せる。 */
function hiddenInClosedDetails(el: HTMLElement): boolean {
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
    if (d.open) continue;
    const summary = d.querySelector(':scope > summary');
    if (!summary || !summary.contains(el)) return true;
  }
  return false;
}

/** Tab で止まる要素を、文書の順に返す。tabindex が負のもの（roving tabindex の休んでいる側）は数えない。 */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.tabIndex >= 0 && !hiddenInClosedDetails(el));
}

/**
 * 開いたときにフォーカスを当てる先。
 * 印（data-autofocus）があればそこ、入力のあるダイアログは最初の欄、欄が無ければ下端の最初の安全な操作にする。
 * 安全な操作は、主ボタンでも危険なボタンでもないもの（やめる、閉じる）である。Enter の押し違いで押し切らせないためである。
 * どれも無ければ器そのものに当て、Esc と読み上げがダイアログから始まるようにする。
 */
function initialTarget(panel: HTMLElement): HTMLElement {
  const marked = panel.querySelector<HTMLElement>('[data-autofocus]');
  if (marked) return marked;
  const body = panel.querySelector<HTMLElement>(':scope > .dialog-body');
  const field = body && tabbables(body).find((el) => el.matches('input, textarea, select'));
  if (field) return field;
  const foot = panel.querySelector<HTMLElement>(':scope > .dialog-foot');
  const safe = foot && tabbables(foot).find((el) => !el.matches('.btn-primary, .btn-danger, .btn-danger-fill'));
  return safe ?? panel;
}

export type DialogProps = {
  /** 見出し。器の名前（aria-labelledby）にもなるので、見える文と読み上げが一致する。 */
  title: ReactNode;
  /** 見出しの右に添えるもの（下書きの札など）。 */
  titleAside?: ReactNode;
  /** 見出しの前のアイコン。danger のときは赤い丸の中に置く。 */
  icon?: IconName;
  /** 取り消せない操作の確認（E1）。見出しの前に赤い丸のアイコンを置き、lead を見出しの下に添える。 */
  danger?: boolean;
  /** 見出しの下の説明。danger のときだけ見出しの段に入れる。 */
  lead?: ReactNode;
  /**
   * 閉じる手。Esc、背景、見出しの右の × がこれを呼ぶ。
   * 無ければどれでも閉じず、× も置かない（未解決のプロジェクトのように、決めてもらうまで閉じないもの）。
   */
  onClose?: () => void;
  /** 見出しの右に × を置くか。既定は閉じる手があれば置く。下端に「閉じる」があるものは外す。 */
  closeButton?: boolean;
  /** 背景を押して閉じるか。入力のあるダイアログは、書きかけを押し違いで失わないよう false にする。 */
  closeOnBackdrop?: boolean;
  /** 下端のボタンの段。スクロールしてもいつも見える。 */
  footer?: ReactNode;
  /** 器に足す class（dialog-wide など）。 */
  className?: string;
  /** 器の中の打鍵。殻の Esc と Tab より先に呼ぶ。既定を止めれば殻は何もしない。 */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  children?: ReactNode;
};

/**
 * ダイアログの共通の殻。見出し、中身、下端のボタンの 3 段で組む（A1）。
 * 器の高さには上限があり、溢れた中身だけがスクロールする。見出しと下端はいつも見える。
 * 開いたら最初の安全な操作へフォーカスを当て、Tab を器の中に閉じ込め、閉じたら開いた元へフォーカスを返す。
 * Esc は殻が受けて onClose を呼び、既定を止める。Root の Esc（何も開いていないときの入力欄を離れる打鍵、器の外の Esc）と重ねないためである。
 */
export function Dialog(props: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { onClose } = props;
  const closeOnBackdrop = props.closeOnBackdrop ?? true;

  // 開いたらフォーカスを入れ、閉じたら開いた元へ返す。
  // 閉じる前にフォーカスが器の外へ移っていたら（画面の移動でターミナルへ移したときなど）、それは奪わない。
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const opener = document.activeElement;
    initialTarget(el).focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const inside = !active || active === document.body || el.contains(active);
      if (inside && opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // 中身が見出しの下をくぐり始めたら見出しの下に、続きがあれば下端の上に影を出す。
  // DOM の事実で描き方だけが変わるので、React の状態にせず属性を直に書く。
  const shade = useCallback(() => {
    const el = panel.current;
    const b = body.current;
    if (!el || !b) return;
    const top = b.scrollTop > 2;
    const bottom = b.scrollTop + b.clientHeight < b.scrollHeight - 2;
    if (top) el.dataset.top = 'true'; else delete el.dataset.top;
    if (bottom) el.dataset.bottom = 'true'; else delete el.dataset.bottom;
  }, []);
  useLayoutEffect(() => {
    shade();
    const b = body.current;
    if (!b || typeof ResizeObserver === 'undefined') return;
    // 詳細を開いたり中身が増えたりして高さが変わったときも、影を付け直す。
    const ro = new ResizeObserver(shade);
    ro.observe(b);
    for (const child of b.children) ro.observe(child);
    return () => ro.disconnect();
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    props.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      // 日本語の変換中の Esc は変換の取り消しなので、欄に残す。
      if (!onClose || isComposing(e)) return;
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const el = panel.current;
    if (!el) return;
    const list = tabbables(el);
    const first = list[0];
    const last = list.at(-1);
    if (!first || !last) { e.preventDefault(); return; }
    const active = document.activeElement;
    const outside = !active || !el.contains(active) || active === el;
    if (e.shiftKey && (active === first || outside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); first.focus(); }
  };

  const title = <b className="dialog-title" id={titleId}>{!props.danger && props.icon && <Icon name={props.icon} />}{props.title}</b>;
  const close = onClose && (props.closeButton ?? true) && (
    <button type="button" className="btn dialog-close" aria-label="閉じる" onClick={onClose}><Icon name="close" /></button>
  );
  const className = ['dialog', props.danger ? 'dialog-danger' : '', props.className ?? ''].filter(Boolean).join(' ');

  return (
    <div
      className="overlay"
      // 背景を押してもフォーカスを器の外（body）へ落とさない。落ちると次の Tab が裏の画面へ出ていく。
      onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}
      onClick={(e) => { if (e.target === e.currentTarget && closeOnBackdrop) onClose?.(); }}
    >
      <div ref={panel} className={className} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        {props.danger ? (
          <div className="dialog-head">
            {props.icon && <span className="dialog-disc"><Icon name={props.icon} /></span>}
            <div className="dialog-head-text">{title}{props.lead && <div className="muted">{props.lead}</div>}</div>
            {props.titleAside}
          </div>
        ) : (
          <div className="dialog-head">{title}{props.titleAside}{close}</div>
        )}
        <div ref={body} className="dialog-body" onScroll={shade}>{props.children}</div>
        {props.footer && <div className="dialog-foot">{props.footer}</div>}
      </div>
    </div>
  );
}
