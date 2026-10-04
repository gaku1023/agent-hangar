import { formatRoute } from '@agent-hangar/shared';
import { useRef } from 'react';
import markUrl from '../brand/logo-mark.svg';
import { useEmit } from '../intent/chain.tsx';
import type { ShellProps, SyncProps, UsageProps } from '../presenters/shell.ts';
import { Icon } from './primitives/Icon.tsx';
import { UsageGauge } from './primitives/UsageGauge.tsx';
import { foldAt } from './headerFold.ts';
import { SyncStatus } from './SyncStatus.tsx';
import { useHeaderFold } from './useHeaderFold.ts';

/** ワードマークを押したときの行き先。 */
const HOME = { name: 'home' } as const;
/** 使用率がまだ取れていないときの行き先。 */
const SETTINGS = { name: 'settings' } as const;

/**
 * ヘッダ。左の列（サイドバーの列）にロゴ、右の列（本文の列）に「探す・移動」の錠剤と右の塊を置く（base.css の .header）。
 * 今いる場所はヘッダではなく、各頁の見出し（PageHeading）で示す。頁ごとに幅の変わる文字をここに置くと、錠剤が頁ごとに横へずれるからである。
 */
export function Header(props: { indexLabel: string | null; usage: UsageProps; sync: SyncProps; newSession: ShellProps['newSession'] }) {
  const emit = useEmit();
  // 右の列は、収まるまで優先度の低い部品から畳む（headerFold.ts）。部品の data-fold-at が、何段目で畳むかを示す。
  const row = useRef<HTMLDivElement>(null);
  useHeaderFold(row);
  const noUsage = props.usage.fiveHour === null && props.usage.sevenDay === null;
  return (
    <header className="header" data-tauri-drag-region="">
      {/* ロゴはサイドバーを開いても畳んでも同じ形、同じ場所に置く。開閉のたびに図のハンガーが揺れる（sidebarMotion.ts）。 */}
      <div className="header-brand" data-tauri-drag-region="">
        <a className="brand" href={formatRoute(HOME)} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: HOME }); }}><img className="brand-mark" src={markUrl} width={26} height={26} alt="" /><span className="brand-word">Hangar</span></a>
      </div>
      <div ref={row} className="header-row" data-tauri-drag-region="">
        {/* 探す入口は打つ欄ではなく、押す錠剤である（A1）。押すか / か ⌘K でパレットを開き、全文検索はパレットの最後の行から行く。
            パレットはこの錠剤から広がって開き、閉じると錠剤へ戻る（CommandPalette.tsx と runtime/present.ts が id で探す）。
            狭いときは文字とキー帽を畳み、虫眼鏡だけを残す。文字は読み上げに残る。 */}
        <button id="global-search" type="button" className="search-pill" title="探す・移動（⌘K または /）" onClick={() => emit({ type: 'palette.open' })}>
          <Icon name="search" /><span className="search-pill-label" data-fold-at={foldAt('search-label')}>探す・移動</span><kbd className="search-kbd" aria-hidden="true" data-fold-at={foldAt('search-label')}>⌘K</kbd>
        </button>
        <span className="spacer" data-tauri-drag-region="" />
        <div className="header-end" data-tauri-drag-region="">
          <SyncStatus {...props.sync} />
          {/* 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。
              最終更新を畳んでも読めるよう、各ゲージの title にも添える。 */}
          {noUsage ? (
            // 値が一度も届いていない間は、空の棒を 2 本並べない。1 語にまとめ、押すと設定へ行く。
            <a className="gauges gauges-none" data-fold-at={foldAt('gauges')} href={formatRoute(SETTINGS)} title="statusline を入れると、5 時間と週の枠の使用率が出ます" onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: SETTINGS }); }}>使用率 未取得</a>
          ) : (
          <span className="gauges" data-fold-at={foldAt('gauges')}>
            <UsageGauge label="5 時間枠の使用率" short="5 時間" percent={props.usage.fiveHour} resets={props.usage.fiveHourResets} updated={props.usage.updatedLabel} />
            <UsageGauge label="週の枠の使用率" short="週" percent={props.usage.sevenDay} resets={props.usage.sevenDayResets} updated={props.usage.updatedLabel} />
            {props.usage.updatedLabel && <span className="faint gauge-updated" data-fold-at={foldAt('gauge-updated')}>最終更新 {props.usage.updatedLabel}</span>}
          </span>
          )}
          {/* 狭いときは「＋」だけになる。名前は aria-label に残す。 */}
          <button className="btn btn-primary new-session" aria-label="新しいセッション" onClick={() => emit({ type: 'session.new.open', ...props.newSession })}><Icon name="add" /><span className="btn-label" data-fold-at={foldAt('new-session-label')}>新しいセッション</span></button>
          {props.indexLabel && <span className="progress" data-fold-at={foldAt('progress')}>{props.indexLabel}</span>}
        </div>
      </div>
    </header>
  );
}
