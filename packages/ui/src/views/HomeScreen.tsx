import { useEmit } from '../intent/chain.tsx';
import type { HomeScreenProps } from '../presenters/home.ts';
import { HomeBand } from './HomeBand.tsx';
import { PageHeading } from './PageHeading.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { SessionList } from './SessionList.tsx';

/** 件数は桁を区切る（タブの件数と同じ書き方）。 */
const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * Home（試作 B）。上から、40px の帯（要対応、実行中、確認待ちの件数の錠剤と、押した群の引き出し）、ステータスのタブ、検索の欄と絞り込みのボタン、平らな一覧の順に置く。
 * 一覧が主役で、札は帯に畳む。朝は要対応の引き出しが開き、検索の最中は引き出しを閉じて件数だけを残す。
 * 3 つの群がどれも 0 件のときは、帯の代わりに 1 行の文と 2 つのボタンを置く。
 * 始める前の確認は、直すものがあるあいだ、帯の最後の群（錠剤と引き出し）になり、帯の右端に 1 行の文を添える（2.11.4）。そろったら帯の群ごと消える。
 * セッションが 1 つも無い人には、一覧の空の札に「クイックセッションを開始」を残す。そのときは、ボタンが重ならないよう、帯の代わりの 1 行のほうを出さない。
 * 一覧は窓の下端までの残りの高さを受け取る（.screen-fill）。続きは、検索なら「さらに読み込む」、そうでなければページ送りで読む。
 */
export function HomeScreen(props: HomeScreenProps) {
  const emit = useEmit();
  const t = useT();
  const loadMore = props.loadMore ? { ...props.loadMore, onLoad: () => emit({ type: 'search.more' }) } : undefined;
  // 手元のセッションが 0 件で、検索も絞り込みも掛かっていない。Archived のものだけを持つ人は、全件が 0 になるのでここに入る。
  const first = props.allCount === 0 && props.list.total === 0 && props.list.mode === 'all';
  const firstCard = (
    <div className="empty-card">
      <h2>{t('home.empty.title')}</h2>
      <p>{props.note !== null ? t('home.empty.textSetup') : t('home.empty.text')}</p>
      <div className="empty-acts">
        <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="scratch" />{t('home.idle.quick')}</button>
        <button type="button" className="btn" onClick={() => emit({ type: 'session.new.open' })}><Icon name="add" />{t('home.idle.new')}</button>
      </div>
    </div>
  );
  return (
    <div className="screen screen-fill home">
      <PageHeading title={t('home.heading.title')} />
      {props.idle
        ? !first && (
          <div className="idle-line">
            <Icon name="nothingRunning" />
            <span className="idle-text">{t('home.idle.text')}</span>
            <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.new.open' })}><Icon name="add" />{t('home.idle.new')}</button>
            <button type="button" className="btn" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="scratch" />{t('home.idle.quick')}</button>
          </div>
        )
        : <HomeBand {...props.band} searching={props.searching} note={props.note} />}
      <div className="list-head"><h2 className="home-label">{t('home.list.title')}<span className="home-count">{t('home.list.count', { n: fmt(props.allCount) })}</span></h2></div>
      <SessionList {...props.list} loadMore={loadMore} empty={first ? firstCard : undefined} />
    </div>
  );
}
