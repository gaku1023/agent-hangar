import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { HomeScreenProps } from '../presenters/home.ts';
import { HomeBand } from './HomeBand.tsx';
import { PageHeading } from './PageHeading.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { fadeIn, resizeFrom } from './primitives/motionKit.ts';
import { SessionList } from './SessionList.tsx';

/**
 * Home（試作 B）。上から、40px の帯（要対応、実行中、確認待ちの件数の錠剤と、押した群の引き出し）、ステータスのタブ、検索の欄と絞り込みのボタン、平らな一覧の順に置く。
 * 一覧の見出し（「セッション n 件」）は置かない。件数はタブが言う。
 * 一覧が主役で、札は帯に畳む。朝は要対応の引き出しが開き、検索の最中は引き出しを閉じて件数だけを残す。
 * 3 つの群がどれも 0 件のときは、帯の代わりに 1 行の文と 2 つのボタンを置く。
 * 始める前の確認は、直すものがあるあいだ、帯の最後の群（錠剤と引き出し）になり、帯の右端に 1 行の文を添える（2.11.4）。そろったら帯の群ごと消える。
 * セッションが 1 つも無い人には、一覧の空の札に「クイックセッションを開始」を残す。そのときは、ボタンが重ならないよう、帯の代わりの 1 行のほうを出さない。
 * 一覧は窓の下端までの残りの高さを受け取る（.screen-fill）。続きは、検索なら「さらに読み込む」、そうでなければページ送りで読む。
 * 帯と 1 行は外の箱（.home-top）に入れ、入れ替わるときは箱の高さを前の高さから補間し、入る方を --dur-fast で薄れから現す（下の一覧は押されて滑る）。
 */
export function HomeScreen(props: HomeScreenProps) {
  const emit = useEmit();
  const t = useT();
  const loadMore = props.loadMore ? { ...props.loadMore, onLoad: () => emit({ type: 'search.more' }) } : undefined;
  // 手元のセッションが 0 件で、検索も絞り込みも掛かっていない。Archived のものだけを持つ人は、全件が 0 になるのでここに入る。
  const first = props.allCount === 0 && props.list.total === 0 && props.list.mode === 'all';
  // 帯の場所に何を出しているか。替わった描画だけ、外の箱の高さを補間する。
  const topKind = props.idle ? (first ? 'none' : 'idle') : 'band';
  const top = useRef<HTMLDivElement>(null);
  const lastKind = useRef(topKind);
  // 前の描画の高さ。引き出しの開閉の動きの途中でも今の高さを持つよう、大きさの変化にも付いていく。
  const lastH = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = top.current;
    if (!el) return;
    const now = el.offsetHeight;
    if (lastKind.current !== topKind && lastH.current !== null) {
      resizeFrom(el, lastH.current);
      const child = el.firstElementChild;
      if (child instanceof HTMLElement) fadeIn(child, '--dur-fast');
    }
    lastKind.current = topKind;
    lastH.current = now;
  });
  useEffect(() => {
    const el = top.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { lastH.current = el.offsetHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const firstCard = (
    <div className="empty-card">
      <h2>{t('home.empty.title')}</h2>
      {/* 説明の文は、確認が済んでいなくても始められることを言うときだけ添える。 */}
      {props.setup && <p>{t('home.empty.textSetup')}</p>}
      <div className="empty-acts">
        <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="scratch" />{t('home.idle.quick')}</button>
        <button type="button" className="btn" onClick={() => emit({ type: 'session.new.open' })}><Icon name="add" />{t('home.idle.new')}</button>
      </div>
    </div>
  );
  return (
    <div className="screen screen-fill home">
      <PageHeading title={t('home.heading.title')} />
      <div ref={top} className="home-top">
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
      </div>
      <SessionList {...props.list} loadMore={loadMore} empty={first ? firstCard : undefined} />
    </div>
  );
}
