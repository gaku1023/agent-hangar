import { formatRoute } from '@agent-hangar/shared';
import markUrl from '../brand/logo-mark.svg';
import { useEmit } from '../intent/chain.tsx';
import { isComposing } from './ime.ts';
import type { ShellProps, SyncProps, UsageProps } from '../presenters/shell.ts';
import { Icon } from './primitives/Icon.tsx';
import { UsageGauge } from './primitives/UsageGauge.tsx';
import { SyncStatus } from './SyncStatus.tsx';

/** ワードマークを押したときの行き先。 */
const HOME = { name: 'home' } as const;

/**
 * ヘッダ。左の列（サイドバーの列）にロゴ、右の列（本文の列）に検索欄と右の塊を置く（base.css の .header）。
 * 今いる場所はヘッダではなく、各頁の見出し（PageHeading）で示す。頁ごとに幅の変わる文字をここに置くと、検索欄が頁ごとに横へずれるからである。
 */
export function Header(props: { searchText: string; indexLabel: string | null; usage: UsageProps; sync: SyncProps; newSession: ShellProps['newSession'] }) {
  const emit = useEmit();
  return (
    <header className="header" data-tauri-drag-region="">
      {/* ロゴはサイドバーを開いても畳んでも同じ形、同じ場所に置く。開閉のたびに図のハンガーが揺れる（sidebarMotion.ts）。 */}
      <div className="header-brand" data-tauri-drag-region="">
        <a className="brand" href={formatRoute(HOME)} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: HOME }); }}><img className="brand-mark" src={markUrl} width={26} height={26} alt="" /><span className="brand-word">Hangar</span></a>
      </div>
      <div className="header-row" data-tauri-drag-region="">
        <input id="global-search" className="input search-box" type="search" role="searchbox" placeholder="セッションを検索（/）" defaultValue={props.searchText}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || isComposing(e)) return;
            const box = e.target as HTMLInputElement;
            emit({ type: 'search.query', text: box.value });
            // 検索し終えたら欄を離れる。フォーカスは結果の一覧へ移る（search.query の focus の効果と、SessionRows の autoFocus）。
            box.blur();
          }} />
        <kbd className="search-kbd" aria-hidden="true">⌘K</kbd>
        {/* 狭いときは検索欄の代わりに出る。押すとパレットを開く。 */}
        <button className="btn search-icon" aria-label="セッションを検索" title="セッションを検索（⌘K）" onClick={() => emit({ type: 'palette.open' })}><Icon name="search" /></button>
        <span className="spacer" data-tauri-drag-region="" />
        <div className="header-end" data-tauri-drag-region="">
          <SyncStatus {...props.sync} />
          {/* 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。 */}
          <span className="gauges">
            <UsageGauge label="5 時間枠の使用率" short="5 時間" percent={props.usage.fiveHour} resets={props.usage.fiveHourResets} />
            <UsageGauge label="週の枠の使用率" short="週" percent={props.usage.sevenDay} resets={props.usage.sevenDayResets} />
            {props.usage.updatedLabel && <span className="faint gauge-updated">最終更新 {props.usage.updatedLabel}</span>}
          </span>
          {/* 狭いときは「＋」だけになる。名前は aria-label に残す。 */}
          <button className="btn btn-primary new-session" aria-label="新しいセッション" onClick={() => emit({ type: 'session.new.open', ...props.newSession })}><Icon name="add" /><span className="btn-label">新しいセッション</span></button>
          {props.indexLabel && <span className="progress">{props.indexLabel}</span>}
        </div>
      </div>
    </header>
  );
}
