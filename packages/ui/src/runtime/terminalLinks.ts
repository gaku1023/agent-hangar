import type { ILink, ILinkProvider } from '@xterm/xterm';
import { isMacClient } from '../keys.ts';

/**
 * ターミナルのリンク。
 * 地の文の URL（@xterm/addon-web-links）と、Claude Code が出す OSC 8 のハイパーリンク（xterm の linkHandler）の両方を、
 * ふつうのターミナルと同じく修飾キー付きのクリック（mac は ⌘、ほかは Ctrl）でだけ開く。
 * 素のクリックは今までどおり文字の選択とフォーカスに使う。
 */

/** 開くクリックか。mac は ⌘、ほかは Ctrl。mac の Ctrl+クリックは右クリックなので使わない。 */
export function isLinkClick(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>, mac: boolean = isMacClient()): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

/** 開いてよい URL なら整えた形を、そうでなければ null を返す。http と https だけで、file: などは開かない。 */
export function openableUrl(text: string): string | null {
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** 開く先。デスクトップ版は殻が既定のブラウザで開き、ブラウザで開いた UI では新しいタブで開く。 */
export function linkOpener(desktop: { openLink(url: string): Promise<void> } | null, open: (url: string, target: string, features: string) => unknown = (u, t, f) => window.open(u, t, f)): (url: string) => void {
  if (desktop) return (url) => { desktop.openLink(url).catch(() => {}); };
  return (url) => { open(url, '_blank', 'noopener,noreferrer'); };
}

/** リンクが押されたとき。修飾キー付きで、開いてよい URL のときだけ開き、開いたかを返す。 */
export function activateLink(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>, text: string, open: (url: string) => void, mac: boolean = isMacClient()): boolean {
  if (!isLinkClick(e, mac)) return false;
  const url = openableUrl(text);
  if (!url) return false;
  open(url);
  return true;
}

/**
 * xterm の内側にあるリンクの提供元の一覧。OSC 8 の組み込みの提供元は公開の API では差し替えられず、飾りがいつも出るので、ここから包む。
 * 内側の置き場なので、xterm を上げて見つからなくなれば null を返す。そのときは xterm の既定の飾りのまま（開くのは修飾キー付きだけのまま）。
 * 置き場は views/xtermLinkProviders.test.ts が見張る。
 */
export function linkProvidersOf(term: unknown): ILinkProvider[] | null {
  const list = (term as { _core?: { _linkProviderService?: { linkProviders?: unknown } } } | null)?._core?._linkProviderService?.linkProviders;
  return Array.isArray(list) ? (list as ILinkProvider[]) : null;
}

const WRAPPED = Symbol('hangar.linkGate');

/**
 * 下線とポインタを、修飾キーを押している間だけ出す（試作 terminal-links の案 A）。
 * xterm はリンクの上に置いただけで下線とポインタを出すので、リンクの提供元を包み、提供するリンクの decorations を押し下げに合わせる。
 * xterm は置いている最中のリンクの decorations を見張っていて、書き換えるとその場で描き直す。
 * mac は ⌘、ほかは Ctrl の押し下げを数える。
 */
export function createLinkGate(mac: boolean = isMacClient()) {
  let held = false;
  let hovered: ILink | null = null;
  const apply = (link: ILink) => {
    if (!link.decorations) return;
    link.decorations.underline = held;
    link.decorations.pointerCursor = held;
  };
  const gateLink = (orig: ILink): ILink => {
    const link: ILink = {
      ...orig,
      decorations: { underline: held, pointerCursor: held },
      hover: (e, text) => {
        // 押したまま入ってきたときは keydown が来ないので、入ったときの押し下げで合わせる。
        held = isLinkClick(e, mac);
        hovered = link;
        apply(link);
        orig.hover?.(e, text);
      },
      leave: (e, text) => {
        if (hovered === link) hovered = null;
        orig.leave?.(e, text);
      },
    };
    return link;
  };
  const wrap = (p: ILinkProvider): ILinkProvider => {
    if ((p as { [WRAPPED]?: true })[WRAPPED]) return p;
    const w: ILinkProvider & { [WRAPPED]: true } = {
      [WRAPPED]: true,
      provideLinks: (y, cb) => p.provideLinks(y, (links) => cb(links?.map(gateLink))),
    };
    return w;
  };
  return {
    /** 一覧の提供元をその場で包む。包み済みは包み直さない。 */
    wrapAll(list: ILinkProvider[]): ILinkProvider[] {
      for (let i = 0; i < list.length; i++) list[i] = wrap(list[i]!);
      return list;
    },
    /** 修飾キーを押した、離した。置いているリンクがあれば、その場で飾りを変える。 */
    setHeld(v: boolean) {
      if (held === v) return;
      held = v;
      if (hovered) apply(hovered);
    },
    held: () => held,
    /** その打鍵が開く修飾キーそのものか（keydown と keyup で見る）。 */
    isModifierKey: (key: string) => key === (mac ? 'Meta' : 'Control'),
  };
}
export type LinkGate = ReturnType<typeof createLinkGate>;
