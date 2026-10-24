import { formatRoute } from '@agent-hangar/shared';
import { useRef } from 'react';
import markUrl from '../brand/logo-mark.svg';
import { useEmit } from '../action/chain.tsx';
import type { HeaderAccountProps, ShellProps, SyncProps, UsageProps } from '../presenters/shell.ts';
import { AccountSwitcher } from './AccountSwitcher.tsx';
import { Bell } from './Bell.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { ariaKeyShortcuts, keyLabel } from '../keys.ts';
import { UsageGauge } from './primitives/UsageGauge.tsx';
import { foldAt } from './headerFold.ts';
import { SyncStatus } from './SyncStatus.tsx';
import { useHeaderFold } from './useHeaderFold.ts';

/** ワードマークを押したときの行き先。 */
const HOME = { name: 'home' } as const;
/** 使用率がまだ取れていないときの行き先。 */
const SETTINGS = { name: 'settings' } as const;

/**
 * ヘッダ。左の列（サイドバーの列）にロゴ、右の列（本文の列）に「移動・操作」の錠剤と右の塊を置く（base.css の .header）。
 * 今いる場所はヘッダではなく、各頁の見出し（PageHeading）で示す。頁ごとに幅の変わる文字をここに置くと、錠剤が頁ごとに横へずれるからである。
 */
export function Header(props: { indexLabel: string | null; usage: UsageProps; account: HeaderAccountProps; sync: SyncProps; notices: ShellProps['notices']; newSession: ShellProps['newSession'] }) {
  const emit = useEmit();
  const t = useT();
  // 右の列は、収まるまで優先度の低い部品から畳む（headerFold.ts）。部品の data-fold-at が、何段目で畳むかを示す。
  const row = useRef<HTMLDivElement>(null);
  useHeaderFold(row);
  const noUsage = props.usage.fiveHour === null && props.usage.sevenDay === null;
  const gauges = (
    <span className="gauges" data-fold-at={foldAt('gauges')}>
      <UsageGauge label={t('header.gauge.fiveHourLabel')} short={t('header.gauge.fiveHourShort')} percent={props.usage.fiveHour} resets={props.usage.fiveHourResets} updated={props.usage.updatedLabel} limited={props.usage.fiveHourLimit ?? null} />
      <UsageGauge label={t('header.gauge.weeklyLabel')} short={t('header.gauge.weeklyShort')} percent={props.usage.sevenDay} resets={props.usage.sevenDayResets} updated={props.usage.updatedLabel} limited={props.usage.sevenDayLimit ?? null} />
    </span>
  );
  return (
    <header className="header" data-tauri-drag-region="">
      {/* ロゴはサイドバーを開いても畳んでも同じ形、同じ場所に置く。開閉のたびに図のハンガーが揺れる（sidebarMotion.ts）。 */}
      <div className="header-brand" data-tauri-drag-region="">
        <a className="brand" href={formatRoute(HOME)} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: HOME }); }}><img className="brand-mark" src={markUrl} width={26} height={26} alt="" /><span className="brand-word">Hangar</span></a>
      </div>
      <div ref={row} className="header-row" data-tauri-drag-region="">
        {/* 探す入口は打つ欄ではなく、押す錠剤である（A1）。押すか / か ⌘K でパレットを開く。パレットは移動と操作の入口で、探すのはホームの欄である（パレットの最後の行から、語を持ってホームへ渡せる）。
            パレットはこの錠剤から広がって開き、閉じると錠剤へ戻る（CommandPalette.tsx と runtime/present.ts が id で探す）。
            大きさは行の幅で 3 段に変わる（base.css）。狭い行では虫眼鏡だけ、中くらいは「移動・操作」とキー帽、広い行では何を探せるかの文とキー帽の長い欄になる。
            読み上げの名前は、どの段でも「移動・操作」である（.sr-only の文）。見える文字と案内の文は見た目のためのもので、読み上げから外す。
            aria-label にしないのは、パレットの入力欄も同じ名前を持ち、名前で探すと 2 つが重なるからである。
            右の塊が入り切らないときは、さらに文字とキー帽を畳み、虫眼鏡だけを残す。 */}
        <button id="global-search" type="button" className="search-pill" aria-keyshortcuts={ariaKeyShortcuts('palette.open')} title={t('header.search.title', { keys: keyLabel('⌘K') })} onClick={() => emit({ type: 'palette.open' })}>
          <Icon name="search" /><span className="sr-only">{t('header.search.label')}</span><span className="search-pill-label" aria-hidden="true" data-fold-at={foldAt('search-label')}>{t('header.search.label')}</span><span className="search-pill-hint" aria-hidden="true" data-fold-at={foldAt('search-label')}>{t('header.search.hint')}</span><kbd className="search-kbd" aria-hidden="true" data-fold-at={foldAt('search-label')}>{keyLabel('⌘K')}</kbd>
        </button>
        <span className="spacer" data-tauri-drag-region="" />
        <div className="header-end" data-tauri-drag-region="">
          <SyncStatus {...props.sync} />
          {/* 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。
              最終更新を畳んでも読めるよう、各ゲージの title にも添える。 */}
          {props.account ? (
            // アカウントが 1 件でもあれば、計器の前に色の点と名前を置き、全体を 1 つのボタンにする（AccountSwitcher.tsx）。1 件でも 2 件以上でも同じ顔と面である。
            // 値が無い間も、押せる。リンクはボタンの中に入れられないので、設定への道は開いた先の「アカウントの設定」に任せる。
            <AccountSwitcher account={props.account}>
              {noUsage ? <span className="account-none" data-fold-at={foldAt('gauges')}>{t('header.gauge.none')}</span> : gauges}
            </AccountSwitcher>
          ) : noUsage ? (
            // アカウントの一覧がまだ届いていない間だけ、ここへ来る。
            // 値が一度も届いていない間は、空の棒を 2 本並べない。1 語にまとめ、押すと設定へ行く。
            <a className="gauges gauges-none" data-fold-at={foldAt('gauges')} href={formatRoute(SETTINGS)} title={t('header.gauge.noneTitle')} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: SETTINGS }); }}>{t('header.gauge.noneLink')}</a>
          ) : gauges}
          {/* 使用制限で止まっているセッションの数（「停止 N」の錠剤）は置かない。ホームの帯の実行中の行と重なるからである（2026-10-13 の決定、9b）。
              注意（もとのベル）は使用率の後ろに置く。畳まない（未読の数が読めなくなるため）。区切りの線は .header-bell が持つ。
              中身が無いときは、区切りの線ごと描かない。 */}
          {props.notices.rows.length > 0 && <span className="header-bell"><Bell {...props.notices} /></span>}
          {/* 狭いときは「＋」だけになる。名前は aria-label に残す。 */}
          <button className="btn btn-primary new-session" aria-label={t('header.new.session')} onClick={() => emit({ type: 'session.new.open', ...props.newSession })}><Icon name="add" /><span className="btn-label" data-fold-at={foldAt('new-session-label')}>{t('header.new.session')}</span></button>
          {props.indexLabel && <span className="progress" data-fold-at={foldAt('progress')}>{props.indexLabel}</span>}
        </div>
      </div>
    </header>
  );
}
